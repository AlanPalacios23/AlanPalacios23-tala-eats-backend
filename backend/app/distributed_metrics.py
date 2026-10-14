from __future__ import annotations

import time
from typing import Any

from .config import settings

LATENCY_BUCKETS_MS = (50, 100, 200, 300, 500, 750, 1000, 1500, 2500, 5000, 10000, 30000, 60000)
_sync_redis = None


def latency_bucket(duration_ms: float) -> int:
    for upper in LATENCY_BUCKETS_MS:
        if duration_ms <= upper:
            return upper
    return LATENCY_BUCKETS_MS[-1]


def _client():
    global _sync_redis
    if not settings.redis_url:
        return None
    if _sync_redis is None:
        import redis
        _sync_redis = redis.Redis.from_url(
            settings.redis_url,
            decode_responses=True,
            max_connections=min(20, settings.redis_max_connections),
            socket_timeout=settings.redis_socket_timeout_seconds,
            socket_connect_timeout=settings.redis_socket_timeout_seconds,
            health_check_interval=30,
        )
    return _sync_redis


def snapshot(minutes: int | None = None) -> dict[str, Any]:
    """Aggregate a small rolling Redis histogram across all API workers."""
    window = max(1, min(minutes or settings.metrics_window_minutes, 15))
    client = _client()
    if client is None:
        return {"available": False, "window_minutes": window, "requests": 0, "errors": 0, "error_rate_percent": 0.0, "p95_ms": 0}
    current = int(time.time() // 60)
    keys = [f"talaeats:metrics:api:{current - i}" for i in range(window)]
    try:
        pipe = client.pipeline(transaction=False)
        for key in keys:
            pipe.hgetall(key)
        rows = pipe.execute()
    except Exception:
        return {"available": False, "window_minutes": window, "requests": 0, "errors": 0, "error_rate_percent": 0.0, "p95_ms": 0}
    total = errors = client_errors = 0
    buckets = {b: 0 for b in LATENCY_BUCKETS_MS}
    for row in rows:
        total += int(row.get("requests", 0) or 0)
        errors += int(row.get("errors", 0) or 0)
        client_errors += int(row.get("client_errors", 0) or 0)
        for b in LATENCY_BUCKETS_MS:
            buckets[b] += int(row.get(f"latency_le_{b}", 0) or 0)
    target = max(1, int(total * 0.95 + 0.999999)) if total else 0
    cumulative = 0
    p95 = 0
    for b in LATENCY_BUCKETS_MS:
        cumulative += buckets[b]
        if target and cumulative >= target:
            p95 = b
            break
    return {
        "available": True,
        "window_minutes": window,
        "requests": total,
        "errors": errors,
        "client_errors": client_errors,
        "error_rate_percent": round((errors / total * 100) if total else 0.0, 2),
        "p95_ms": p95,
        "latency_histogram": {str(k): v for k, v in buckets.items()},
    }
