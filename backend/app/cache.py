from __future__ import annotations

import json
import logging
from typing import Any

from .config import settings

log = logging.getLogger("talaeats.cache")
_redis = None


def _client():
    global _redis
    if _redis is None and settings.redis_url:
        import redis
        _redis = redis.Redis.from_url(settings.redis_url, decode_responses=True, max_connections=settings.redis_max_connections, socket_timeout=settings.redis_socket_timeout_seconds, socket_connect_timeout=settings.redis_socket_timeout_seconds, health_check_interval=30)
    return _redis


def catalog_version() -> str:
    client = _client()
    if client is None:
        return "0"
    try:
        return client.get("talaeats:cache:catalog:version") or "0"
    except Exception:
        return "0"


def bump_catalog_version() -> None:
    client = _client()
    if client is None:
        return
    try:
        client.incr("talaeats:cache:catalog:version")
    except Exception:
        log.exception("catalog cache invalidation failed")


def get_json(key: str) -> Any | None:
    client = _client()
    if client is None:
        return None
    try:
        raw = client.get(key)
        return json.loads(raw) if raw else None
    except Exception:
        log.exception("cache read failed")
        return None


def set_json(key: str, value: Any, ttl: int = 20) -> None:
    client = _client()
    if client is None:
        return
    try:
        client.set(key, json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str), ex=max(1, ttl))
    except Exception:
        log.exception("cache write failed")
