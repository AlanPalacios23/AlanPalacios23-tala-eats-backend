"""Phase-1 proxy trust tests; use in-memory Starlette scopes (no network)."""
import asyncio

from starlette.requests import Request
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app.middleware import _client_ip


def _request(client: str, headers: dict[str, str]) -> Request:
    return Request({
        "type": "http",
        "method": "POST",
        "path": "/api/v1/auth/login",
        "scheme": "https",
        "server": ("talaeats.example", 443),
        "client": (client, 55555),
        "root_path": "",
        "query_string": b"",
        "headers": [
            (key.lower().encode(), value.encode()) for key, value in headers.items()
        ],
    })


def test_visitor_cannot_invent_a_new_rate_limit_identity_with_forwarded_headers():
    peer = "198.51.100.21"
    for forged in [
        {"CF-Connecting-IP": "203.0.113.1"},
        {"X-Forwarded-For": "203.0.113.2, 198.51.100.21"},
        {"X-Real-IP": "203.0.113.3"},
        {"CF-Connecting-IP": "bad", "X-Forwarded-For": "203.0.113.4"},
    ]:
        assert _client_ip(_request(peer, forged)) == peer


def test_uvicorn_resolved_ip_is_used_as_authoritative_peer():
    # Uvicorn (with a restricted allowlist) sets scope.client before FastAPI.
    assert _client_ip(_request("203.0.113.8", {})) == "203.0.113.8"
    assert _client_ip(_request("2001:db8::1", {})) == "2001:db8::1"


def test_malformed_peer_is_one_safe_rate_limit_bucket():
    assert _client_ip(_request("spoof-this", {"CF-Connecting-IP": "203.0.113.1"})) == "unknown"
    assert _client_ip(_request("another-spoof", {"X-Forwarded-For": "203.0.113.9"})) == "unknown"


def test_uvicorn_rewrites_peer_only_when_proxy_is_allowlisted():
    seen = []
    async def endpoint(scope, receive, send):
        seen.append(scope["client"][0])
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})
    upstream = ProxyHeadersMiddleware(endpoint, trusted_hosts=["127.0.0.1"])

    async def ignored():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def response_sink(message):
        pass

    fake_untrusted = _request("198.51.100.8", {"X-Forwarded-For": "203.0.113.123"}).scope
    asyncio.run(upstream(fake_untrusted, ignored, response_sink))
    assert seen[-1] == "198.51.100.8", seen

    real_local_proxy = _request("127.0.0.1", {"X-Forwarded-For": "203.0.113.123"}).scope
    asyncio.run(upstream(real_local_proxy, ignored, response_sink))
    assert seen[-1] == "203.0.113.123", seen
