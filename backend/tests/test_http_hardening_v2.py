"""Regresiones de la capa HTTP sin red, Redis productivo ni pagos reales."""
import asyncio

import pytest
from starlette.requests import Request
from starlette.responses import JSONResponse

from app.config import settings
from app.middleware import IdempotencyMiddleware, RequestSizeLimitMiddleware
from app import middleware


def make_request(path: str, *, method: str = "POST",
                 body: bytes = b'{"x":1}', key: str = "tala-test-key"):
    raw_headers = [(b"content-type", b"application/json"),
                   (b"content-length", str(len(body)).encode()),
                   (b"idempotency-key", key.encode())]
    scope = {
        "type": "http", "method": method, "path": path,
        "scheme": "http", "server": ("testserver", 80),
        "client": ("127.0.0.1", 5001), "root_path": "",
        "headers": raw_headers, "query_string": b"",
    }
    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}
    return Request(scope, receive)


def middleware_instance():
    return IdempotencyMiddleware(app=lambda *args: None)


def test_auth_requests_are_never_cached_or_replayed(monkeypatch):
    monkeypatch.setattr(settings, "redis_url", "redis://unreachable.invalid")
    async def forbidden_redis():
        raise AssertionError("authentication must not use the idempotency response cache")
    monkeypatch.setattr(middleware, "_get_rate_redis", forbidden_redis)
    calls = []
    async def fake_auth(request):
        calls.append(request.url.path)
        response = JSONResponse({"access_token": "unique-test-secret", "device_token": "test-only"})
        response.set_cookie("talaeats_session", "session-not-to-cache")
        return response
    async def run():
        paths = [
            "/api/v1/auth/login", "/api/v1/auth/register",
            "/api/v1/auth/google", "/api/v1/auth/logout",
            "/api/v1/auth/password/forgot", "/api/v1/auth/password/reset",
        ]
        for route in paths:
            result = await middleware_instance().dispatch(make_request(route), fake_auth)
            assert result.status_code == 200
            assert "x-idempotency-replayed" not in result.headers
        assert calls == paths
    asyncio.run(run())


def test_provider_signed_webhook_skips_generic_response_cache(monkeypatch):
    monkeypatch.setattr(settings, "redis_url", "redis://unreachable.invalid")
    async def forbidden_redis():
        raise AssertionError("webhook handlers own signed-event deduplication")
    monkeypatch.setattr(middleware, "_get_rate_redis", forbidden_redis)
    called = []
    async def handler(request):
        called.append(request.url.path)
        return JSONResponse({"ok": True})
    async def run():
        for path in ["/api/v1/stripe/webhook",
                     "/api/v1/payments/mercadopago/webhook",
                     "/api/v1/v11/payouts/webhook"]:
            response = await middleware_instance().dispatch(make_request(path), handler)
            assert response.status_code == 200
        assert len(called) == 3
    asyncio.run(run())


class FakeRedis:
    def __init__(self):
        self.values = {}
        self.cache_writes = 0
        self.eval_calls = 0
    async def get(self, key):
        return self.values.get(key)
    async def set(self, key, value, *, nx=False, ex=None):
        if nx and key in self.values:
            return False
        if key.startswith("idem:response"):
            self.cache_writes += 1
        self.values[key] = value
        return True
    async def eval(self, script, count, key, token):
        assert count == 1
        self.eval_calls += 1
        if self.values.get(key) == token:
            self.values.pop(key, None)
            return 1
        return 0


def test_idempotency_keeps_checkout_replay_but_does_not_delete_new_owner(monkeypatch):
    monkeypatch.setattr(settings, "redis_url", "redis://qa-only")
    fake = FakeRedis()
    async def get_redis(): return fake
    monkeypatch.setattr(middleware, "_get_rate_redis", get_redis)
    ran = []
    async def endpoint(request):
        ran.append(True)
        if len(ran) == 1:
            # Simulate an old 120s lock expiring and a concurrent request
            # claiming the same key while this handler is still completing.
            lock = next(key for key in fake.values if key.startswith("idem:lock:"))
            fake.values[lock] = "new-owner-token"
        return JSONResponse({"order_id": 55, "price": 249})

    async def run():
        req = lambda: make_request("/api/v1/orders")
        first = await middleware_instance().dispatch(req(), endpoint)
        assert first.status_code == 200
        assert fake.cache_writes == 1
        lock = next(key for key in fake.values if key.startswith("idem:lock:"))
        assert fake.values[lock] == "new-owner-token"
        second = await middleware_instance().dispatch(req(), endpoint)
        assert second.headers.get("x-idempotency-replayed") == "true"
        assert len(ran) == 1
        assert fake.eval_calls == 1
    asyncio.run(run())


def test_cookie_and_private_responses_never_persist_in_cache(monkeypatch):
    monkeypatch.setattr(settings, "redis_url", "redis://qa-only")
    fake = FakeRedis()
    async def get_redis(): return fake
    monkeypatch.setattr(middleware, "_get_rate_redis", get_redis)
    calls = []
    async def endpoint(request):
        calls.append(True)
        res = JSONResponse({"token": "not-to-be-cached"})
        res.set_cookie("test_session", "secret")
        res.headers["Cache-Control"] = "private, no-store"
        return res

    async def run():
        first = await middleware_instance().dispatch(make_request("/api/v1/order-secret"), endpoint)
        second = await middleware_instance().dispatch(make_request("/api/v1/order-secret"), endpoint)
        assert first.headers.get("set-cookie") is not None
        assert second.headers.get("set-cookie") is not None
        assert len(calls) == 2
        assert fake.cache_writes == 0
    asyncio.run(run())


def test_large_request_skips_unsafe_content_length_only_signature(monkeypatch):
    monkeypatch.setattr(settings, "redis_url", "redis://qa-only")
    async def forbidden_redis():
        raise AssertionError("large requests must bypass redis generic replay")
    monkeypatch.setattr(middleware, "_get_rate_redis", forbidden_redis)
    calls = []
    async def endpoint(request):
        calls.append(True)
        return JSONResponse({"ok": True})
    async def run():
        huge = b"x" * (2 * 1024 * 1024 + 1)
        res = await middleware_instance().dispatch(make_request("/api/v1/uploads/file", body=huge), endpoint)
        assert res.status_code == 200
        assert calls == [True]
    asyncio.run(run())


def test_negative_content_length_is_rejected():
    async def handler(request):
        raise AssertionError("invalid length must stop before handlers")
    request = make_request("/api/v1/orders")
    request.scope["headers"] = [(b"content-length", b"-1")]
    result = asyncio.run(RequestSizeLimitMiddleware(app=lambda *args: None).dispatch(request, handler))
    assert result.status_code == 400
