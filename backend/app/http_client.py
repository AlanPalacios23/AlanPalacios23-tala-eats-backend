"""Connection-pooled provider HTTP client with lightweight circuit breakers.

Normal FastAPI ``def`` routes run in a threadpool, so one Session per thread keeps
TLS connections alive without sharing mutable requests.Session state. Circuit
state is process-wide and intentionally small; provider failures cannot consume all
API worker threads indefinitely.
"""
from __future__ import annotations

import time
from threading import Lock, local
from urllib.parse import urlparse

import requests
from requests.adapters import HTTPAdapter

from .config import settings

_state = local()
_breaker_lock = Lock()
_breakers: dict[str, dict[str, float | int]] = {}
_FAILURE_THRESHOLD = 5
_OPEN_SECONDS = 30


def session() -> requests.Session:
    client = getattr(_state, "session", None)
    if client is None:
        client = requests.Session()
        adapter = HTTPAdapter(pool_connections=20, pool_maxsize=100, max_retries=0, pool_block=True)
        client.mount("https://", adapter)
        client.mount("http://", adapter)
        client.headers.update({"User-Agent": f"TalaEats-Backend/{settings.app_version}"})
        _state.session = client
    return client


def _provider(url: str) -> str:
    return (urlparse(url).hostname or "unknown").lower()


def _synthetic_response(url: str, status: int, text: str) -> requests.Response:
    response = requests.Response()
    response.status_code = status
    response.url = url
    response._content = text.encode("utf-8")
    response.headers["content-type"] = "text/plain; charset=utf-8"
    return response


def _can_attempt(key: str) -> bool:
    now = time.monotonic()
    with _breaker_lock:
        row = _breakers.get(key)
        if not row:
            return True
        opened_until = float(row.get("opened_until", 0))
        if opened_until and now < opened_until:
            return False
        if opened_until:
            # half-open: allow the next probe
            row["opened_until"] = 0
        return True


def _record(key: str, ok: bool) -> None:
    with _breaker_lock:
        row = _breakers.setdefault(key, {"failures": 0, "opened_until": 0})
        if ok:
            row["failures"] = 0
            row["opened_until"] = 0
            return
        row["failures"] = int(row.get("failures", 0)) + 1
        if int(row["failures"]) >= _FAILURE_THRESHOLD:
            row["opened_until"] = time.monotonic() + _OPEN_SECONDS


def circuit_breaker_snapshot() -> dict[str, dict[str, int | bool]]:
    now = time.monotonic()
    with _breaker_lock:
        return {
            key: {
                "failures": int(row.get("failures", 0)),
                "open": float(row.get("opened_until", 0)) > now,
                "retry_in_seconds": max(0, int(float(row.get("opened_until", 0)) - now)),
            }
            for key, row in _breakers.items()
        }


def _request(method: str, url: str, *args, **kwargs):
    key = _provider(url)
    if not _can_attempt(key):
        return _synthetic_response(url, 503, "provider circuit breaker open")
    try:
        response = session().request(method, url, *args, **kwargs)
    except Exception:
        _record(key, False)
        raise
    _record(key, response.status_code < 500 and response.status_code != 429)
    return response


def get(url, *args, **kwargs):
    return _request("GET", url, *args, **kwargs)


def post(url, *args, **kwargs):
    return _request("POST", url, *args, **kwargs)
