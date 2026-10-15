import asyncio
import json
import logging
import re
import time
import uuid
from collections import deque
from threading import Lock

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, Response

from .config import settings
from .request_context import request_id_var, request_ip_var
from .distributed_metrics import latency_bucket

logger = logging.getLogger("talaeats.access")
_local_buckets: dict[str, tuple[float, int]] = {}
_rate_redis = None
_rate_redis_lock = asyncio.Lock()
_local_rate_lock = asyncio.Lock()
_NUMERIC_SEGMENT = re.compile(r"/(?:\d+)(?=/|$)")


async def _get_rate_redis():
    global _rate_redis
    if not settings.redis_url:
        return None
    if _rate_redis is not None:
        return _rate_redis
    async with _rate_redis_lock:
        if _rate_redis is None:
            import redis.asyncio as aioredis
            pool = aioredis.ConnectionPool.from_url(
                settings.redis_url,
                decode_responses=True,
                max_connections=settings.redis_max_connections,
                socket_connect_timeout=settings.redis_socket_timeout_seconds,
                socket_timeout=settings.redis_socket_timeout_seconds,
                health_check_interval=30,
            )
            _rate_redis = aioredis.Redis(connection_pool=pool)
    return _rate_redis


async def close_runtime_clients() -> None:
    global _rate_redis
    client = _rate_redis
    _rate_redis = None
    if client is not None:
        try:
            await client.aclose()
        except Exception:
            logger.exception("Failed to close Redis rate-limit pool")


async def _record_distributed_metric(status: int, duration_ms: float) -> None:
    if not settings.redis_url:
        return
    try:
        client = await _get_rate_redis()
        if client is None:
            return
        minute = int(time.time() // 60)
        key = f"talaeats:metrics:api:{minute}"
        bucket = latency_bucket(duration_ms)
        pipe = client.pipeline(transaction=False)
        pipe.hincrby(key, "requests", 1)
        if status >= 500:
            pipe.hincrby(key, "errors", 1)
        elif status >= 400:
            pipe.hincrby(key, "client_errors", 1)
        pipe.hincrby(key, f"latency_le_{bucket}", 1)
        pipe.expire(key, 1200)
        await pipe.execute()
    except Exception:
        # Metrics must never affect the request path. OTel/in-process metrics remain.
        logger.debug("distributed metrics unavailable", exc_info=True)


async def _local_rate_take(policy: str, identity: str, limit: int) -> tuple[bool, int]:
    """Per-process fallback limiter used in development and during Redis outages."""
    now = time.monotonic()
    local_key = f"{policy}:{identity}"
    async with _local_rate_lock:
        start, current = _local_buckets.get(local_key, (now, 0))
        if now - start >= 60:
            start, current = now, 0
        count = current + 1
        _local_buckets[local_key] = (start, count)
        if len(_local_buckets) > 10_000:
            stale_before = now - 120
            for stale_key, (seen, _) in list(_local_buckets.items())[:5000]:
                if seen < stale_before:
                    _local_buckets.pop(stale_key, None)
    return count <= limit, count


def _metric_path(path: str) -> str:
    if path.startswith("/media/"):
        return "/media/*"
    if path.startswith("/ws/orders/"):
        return "/ws/orders/:id"
    return _NUMERIC_SEGMENT.sub("/:id", path)


class RuntimeMetrics:
    """Compact in-process stability window; OTel remains the long-term source."""

    def __init__(self, max_samples: int = 2000):
        self._samples = deque(maxlen=max_samples)
        self._lock = Lock()
        self.started_at = time.time()

    def record(self, method: str, path: str, status: int, duration_ms: float) -> None:
        with self._lock:
            self._samples.append(
                {
                    "at": time.time(),
                    "method": method,
                    "path": _metric_path(path),
                    "status": int(status),
                    "duration_ms": float(duration_ms),
                }
            )

    def snapshot(self) -> dict:
        with self._lock:
            samples = list(self._samples)
        durations = sorted(s["duration_ms"] for s in samples)
        total = len(samples)
        errors = sum(1 for s in samples if s["status"] >= 500)
        client_errors = sum(1 for s in samples if 400 <= s["status"] < 500)
        slow = sum(1 for s in samples if s["duration_ms"] >= settings.slow_request_ms)

        def percentile(p: float) -> float:
            if not durations:
                return 0.0
            idx = min(len(durations) - 1, max(0, int(round((len(durations) - 1) * p))))
            return round(durations[idx], 2)

        by_path: dict[str, dict] = {}
        for sample in samples:
            key = f'{sample["method"]} {sample["path"]}'
            row = by_path.setdefault(key, {"requests": 0, "errors": 0, "max_ms": 0.0})
            row["requests"] += 1
            row["errors"] += int(sample["status"] >= 500)
            row["max_ms"] = max(row["max_ms"], sample["duration_ms"])
        slowest = sorted(
            ({"route": k, **v, "max_ms": round(v["max_ms"], 2)} for k, v in by_path.items()),
            key=lambda x: x["max_ms"],
            reverse=True,
        )[:10]
        return {
            "window_requests": total,
            "server_errors": errors,
            "client_errors": client_errors,
            "error_rate_percent": round((errors / total * 100) if total else 0, 2),
            "slow_requests": slow,
            "p50_ms": percentile(0.50),
            "p95_ms": percentile(0.95),
            "p99_ms": percentile(0.99),
            "uptime_seconds": max(0, int(time.time() - self.started_at)),
            "slowest_routes": slowest,
        }


runtime_metrics = RuntimeMetrics()


def _client_ip(request: Request) -> str:
    """Use the ASGI peer, NEVER raw visitor-controlled forwarding headers.

    Uvicorn may rewrite scope["client"] only when the immediate proxy is in
    UVICORN_FORWARDED_ALLOW_IPS. Caddy must strip/overwrite client-supplied
    X-Forwarded-For. Trusting CF-Connecting-IP here would bypass that gate.
    """
    from ipaddress import ip_address

    peer = request.client.host if request.client else ""
    try:
        return ip_address(peer).compressed
    except ValueError:
        # A malformed forwarded value must not create unlimited rate-limit
        # identities via arbitrary strings. Fail closed on a shared bucket.
        return "unknown"


def _rate_policy(request: Request) -> tuple[str, int]:
    if not settings.is_production:
        return "development", max(settings.rate_limit_per_minute, 2000)
    path = request.url.path
    if path.startswith("/api/v1/auth/login") or path.startswith("/api/v1/auth/forgot") or path.startswith("/api/v1/auth/password"):
        return "auth", settings.rate_limit_auth_per_minute
    if path.startswith("/api/v1/uploads/") and request.method == "POST":
        return "upload", settings.rate_limit_upload_per_minute
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        return "mutation", settings.rate_limit_mutation_per_minute
    return "general", settings.rate_limit_per_minute


class RequestSizeLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # Caddy enforces the hard streaming limit. This early check avoids reading
        # an obviously oversized body inside the app when Content-Length exists.
        if request.method in {"POST", "PUT", "PATCH"}:
            raw = request.headers.get("content-length")
            if raw:
                try:
                    size = int(raw)
                except ValueError:
                    return JSONResponse({"detail": "Content-Length inválido"}, status_code=400)
                max_bytes = settings.max_request_body_mb * 1024 * 1024
                if size > max_bytes:
                    return JSONResponse(
                        {"detail": f"La solicitud supera el máximo de {settings.max_request_body_mb} MB"},
                        status_code=413,
                    )
        return await call_next(request)


class RequestContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        request_id = (request.headers.get("x-request-id") or str(uuid.uuid4()))[:128]
        request.state.request_id = request_id
        token_request_id = request_id_var.set(request_id)
        token_ip = request_ip_var.set(_client_ip(request))
        started = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            response.headers["X-Request-ID"] = request_id
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
            response.headers["Permissions-Policy"] = "camera=(self), geolocation=(self), microphone=()"
            response.headers["Cross-Origin-Opener-Policy"] = "same-origin-allow-popups"
            response.headers["X-Permitted-Cross-Domain-Policies"] = "none"
            response.headers["X-Frame-Options"] = "SAMEORIGIN"
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; script-src 'self' https://accounts.google.com; "
                "style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: blob: https:; "
                "connect-src 'self' https: wss:; "
                "frame-src https://accounts.google.com https://www.mercadopago.com https://*.mercadopago.com; "
                "font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'"
            )
            if settings.is_production:
                response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains; preload"
            return response
        finally:
            duration_ms = round((time.perf_counter() - started) * 1000, 2)
            runtime_metrics.record(request.method, request.url.path, status, duration_ms)
            await _record_distributed_metric(status, duration_ms)
            logger.info(
                json.dumps(
                    {
                        "request_id": request_id,
                        "method": request.method,
                        "path": _metric_path(request.url.path),
                        "status": status,
                        "duration_ms": duration_ms,
                        "slow": duration_ms >= settings.slow_request_ms,
                        "ip": _client_ip(request),
                    }
                )
            )
            request_id_var.reset(token_request_id)
            request_ip_var.reset(token_ip)


class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path in {"/api/v1/health", "/api/v1/ready", "/"} or request.url.path.startswith("/media/"):
            return await call_next(request)

        policy, limit = _rate_policy(request)
        bucket = int(time.time() // 60)
        identity = _client_ip(request)
        key = f"ratelimit:{policy}:{identity}:{bucket}"
        allowed = True
        count = 0
        reset_in = 60 - (int(time.time()) % 60)

        if settings.redis_url:
            try:
                client = await _get_rate_redis()
                pipe = client.pipeline(transaction=True)
                pipe.incr(key)
                pipe.expire(key, 70)
                values = await pipe.execute()
                count = int(values[0])
                allowed = count <= limit
            except Exception:
                # Never fail completely open. Redis keeps limits consistent across workers;
                # during an outage each worker still enforces a bounded local fallback.
                logger.exception("Redis rate limiter unavailable; using local fallback")
                allowed, count = await _local_rate_take(policy, identity, limit)
        else:
            allowed, count = await _local_rate_take(policy, identity, limit)

        if not allowed:
            return JSONResponse(
                {"detail": "Demasiadas solicitudes. Intenta de nuevo en un momento."},
                status_code=429,
                headers={
                    "Retry-After": str(reset_in),
                    "X-RateLimit-Limit": str(limit),
                    "X-RateLimit-Remaining": "0",
                    "X-RateLimit-Reset": str(reset_in),
                },
            )

        response = await call_next(request)
        if count:
            response.headers["X-RateLimit-Limit"] = str(limit)
            response.headers["X-RateLimit-Remaining"] = str(max(0, limit - count))
            response.headers["X-RateLimit-Reset"] = str(reset_in)
        return response


class IdempotencyMiddleware(BaseHTTPMiddleware):
    """Redis-backed replay protection for mutating API requests.

    A key is bound to identity + method + path + request signature. Reusing the
    same key with different input is rejected instead of replaying the wrong
    response. Domain unique constraints remain the final correctness layer.
    """
    async def dispatch(self, request: Request, call_next):
        if request.method in {"GET", "HEAD", "OPTIONS"} or not request.url.path.startswith("/api/"):
            return await call_next(request)
        idem = request.headers.get("idempotency-key", "").strip()[:180]
        if not idem or not settings.redis_url:
            return await call_next(request)
        authorization = request.headers.get("authorization", "")
        cookie_token = request.cookies.get(settings.session_cookie_name, "")
        # Login/register can set a cookie on the first response; binding identity to
        # that newly-created cookie would make the retry look like a different caller.
        auth_bootstrap = request.url.path.startswith(("/api/v1/auth/login", "/api/v1/auth/register", "/api/v1/auth/google", "/api/v1/auth/password/forgot"))
        auth = authorization or ("" if auth_bootstrap else cookie_token)
        import hashlib
        identity = hashlib.sha256(auth.encode()).hexdigest()[:16] if auth else _client_ip(request)
        semantic = hashlib.sha256(f"{identity}|{request.method}|{request.url.path}|{idem}".encode()).hexdigest()
        cache_key = f"idem:response:{semantic}"
        lock_key = f"idem:lock:{semantic}"
        signature_key = f"idem:signature:{semantic}"
        try:
            raw_len = int(request.headers.get("content-length") or 0)
            if raw_len <= 2 * 1024 * 1024:
                body = await request.body()
                signature_material = request.url.query.encode() + b"\0" + body
            else:
                signature_material = f"{request.url.query}|len={raw_len}|ct={request.headers.get('content-type','')}".encode()
            request_signature = hashlib.sha256(signature_material).hexdigest()
            client = await _get_rate_redis()
            previous_signature = await client.get(signature_key)
            if previous_signature and previous_signature != request_signature:
                return JSONResponse({"detail": "Idempotency-Key ya fue usada con una solicitud diferente"}, status_code=409)
            if not previous_signature:
                stored = await client.set(signature_key, request_signature, nx=True, ex=86400)
                if not stored:
                    previous_signature = await client.get(signature_key)
                    if previous_signature and previous_signature != request_signature:
                        return JSONResponse({"detail": "Idempotency-Key ya fue usada con una solicitud diferente"}, status_code=409)
            cached = await client.get(cache_key)
            if cached:
                payload = json.loads(cached)
                return Response(content=payload["body"].encode("utf-8"), status_code=int(payload["status"]), media_type=payload.get("content_type") or "application/json", headers={"X-Idempotency-Replayed": "true"})
            claimed = await client.set(lock_key, "1", nx=True, ex=30)
            if not claimed:
                for _ in range(10):
                    await asyncio.sleep(0.1)
                    cached = await client.get(cache_key)
                    if cached:
                        payload = json.loads(cached)
                        return Response(content=payload["body"].encode("utf-8"), status_code=int(payload["status"]), media_type=payload.get("content_type") or "application/json", headers={"X-Idempotency-Replayed": "true"})
                return JSONResponse({"detail": "Una solicitud idéntica sigue en proceso"}, status_code=409, headers={"Retry-After": "1"})
        except Exception:
            logger.exception("Idempotency Redis unavailable; falling back to endpoint guarantees")
            return await call_next(request)

        try:
            response = await call_next(request)
            body = b""
            async for chunk in response.body_iterator:
                body += chunk
            rebuilt = Response(content=body, status_code=response.status_code, headers={k: v for k, v in response.headers.items() if k.lower() != "content-length"}, media_type=response.media_type)
            if response.status_code < 500 and len(body) <= 2 * 1024 * 1024:
                try:
                    await client.set(cache_key, json.dumps({"status": response.status_code, "content_type": response.media_type or response.headers.get("content-type", "application/json"), "body": body.decode("utf-8")}), ex=86400)
                except Exception:
                    logger.exception("Could not cache idempotent response")
            return rebuilt
        finally:
            try:
                await client.delete(lock_key)
            except Exception:
                pass


class OriginGuardMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if (
            not settings.is_production
            or request.method in {"GET", "HEAD", "OPTIONS"}
            or request.url.path.startswith("/api/v1/payments/mercadopago/webhook")
            or request.url.path.startswith("/api/v1/v11/payouts/webhook")
        ):
            return await call_next(request)
        origin = request.headers.get("origin")
        if origin and origin not in settings.cors_origins and origin != settings.frontend_url:
            return JSONResponse({"detail": "Origen no permitido"}, status_code=403)
        return await call_next(request)
