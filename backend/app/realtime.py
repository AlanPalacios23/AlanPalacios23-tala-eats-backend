import json
import logging
from threading import Lock
from typing import Any

from .config import settings

log = logging.getLogger("talaeats.realtime")
_sync_client = None
_sync_lock = Lock()
_async_client = None
_async_lock = None


def _redis_modules():
    try:
        import redis
        import redis.asyncio as aioredis
        return redis, aioredis
    except ImportError:
        return None, None


def _sync():
    global _sync_client
    redis, _ = _redis_modules()
    if not settings.redis_url or redis is None:
        return None
    if _sync_client is None:
        with _sync_lock:
            if _sync_client is None:
                pool = redis.ConnectionPool.from_url(
                    settings.redis_url,
                    decode_responses=True,
                    max_connections=settings.redis_max_connections,
                    socket_connect_timeout=settings.redis_socket_timeout_seconds,
                    socket_timeout=settings.redis_socket_timeout_seconds,
                    health_check_interval=30,
                )
                _sync_client = redis.Redis(connection_pool=pool)
    return _sync_client



def cache_driver_location(driver_id: int, lat: float, lng: float) -> bool:
    """Cache high-frequency driver GPS in Redis and decide whether DB persistence is due.

    Returns True when the caller should persist the location to PostgreSQL. Without
    Redis we deliberately return True so development and degraded mode stay correct.
    """
    client = _sync()
    if client is None:
        return True
    try:
        payload = json.dumps({"lat": float(lat), "lng": float(lng)})
        pipe = client.pipeline(transaction=False)
        pipe.set(f"talaeats:driver:{driver_id}:location", payload, ex=120)
        pipe.set(
            f"talaeats:driver:{driver_id}:location:persist",
            "1",
            nx=True,
            ex=settings.driver_location_db_interval_seconds,
        )
        _, persist_claimed = pipe.execute()
        return bool(persist_claimed)
    except Exception:
        log.exception("Redis driver location cache failed driver_id=%s", driver_id)
        return True


def driver_locations(driver_ids: list[int]) -> dict[int, tuple[float, float]]:
    """Return freshest cached GPS locations for a batch of drivers."""
    if not driver_ids:
        return {}
    client = _sync()
    if client is None:
        return {}
    try:
        keys = [f"talaeats:driver:{driver_id}:location" for driver_id in driver_ids]
        values = client.mget(keys)
        result = {}
        for driver_id, raw in zip(driver_ids, values):
            if not raw:
                continue
            data = json.loads(raw)
            result[int(driver_id)] = (float(data["lat"]), float(data["lng"]))
        return result
    except Exception:
        log.exception("Redis batch driver location read failed")
        return {}

def redis_ping() -> tuple[bool, str | None]:
    if not settings.redis_url:
        return True, None
    client = _sync()
    if client is None:
        return False, None
    try:
        ok = bool(client.ping())
        heartbeat = client.get("talaeats:worker:heartbeat") if ok else None
        return ok, heartbeat
    except Exception:
        log.exception("Redis health check failed")
        return False, None


def publish_order_event(order_id: int, event: str, data: dict[str, Any] | None = None) -> None:
    client = _sync()
    if not client:
        return
    try:
        client.publish(
            f"talaeats:order:{order_id}",
            json.dumps({"order_id": order_id, "event": event, "data": data or {}}, default=str),
        )
    except Exception:
        log.exception("Redis publish failed order_id=%s event=%s", order_id, event)


def publish_user_event(user_id: int, event: str, data: dict[str, Any] | None = None) -> None:
    client = _sync()
    if not client:
        return
    try:
        client.publish(
            f"talaeats:user:{user_id}",
            json.dumps({"user_id": user_id, "event": event, "data": data or {}}, default=str),
        )
    except Exception:
        log.exception("Redis publish failed user_id=%s event=%s", user_id, event)


async def _async():
    global _async_client, _async_lock
    _, aioredis = _redis_modules()
    if not settings.redis_url or aioredis is None:
        return None
    if _async_lock is None:
        import asyncio
        _async_lock = asyncio.Lock()
    if _async_client is None:
        async with _async_lock:
            if _async_client is None:
                pool = aioredis.ConnectionPool.from_url(
                    settings.redis_url,
                    decode_responses=True,
                    max_connections=settings.redis_max_connections,
                    socket_connect_timeout=settings.redis_socket_timeout_seconds,
                    socket_timeout=30,
                    health_check_interval=30,
                )
                _async_client = aioredis.Redis(connection_pool=pool)
    return _async_client


async def order_pubsub(order_id: int):
    client = await _async()
    if client is None:
        return None
    pubsub = client.pubsub()
    await pubsub.subscribe(f"talaeats:order:{order_id}")
    return pubsub


async def close_realtime_clients() -> None:
    global _async_client, _sync_client
    client = _async_client
    _async_client = None
    if client is not None:
        try:
            await client.aclose()
        except Exception:
            log.exception("Failed closing async Redis client")
    sync_client = _sync_client
    _sync_client = None
    if sync_client is not None:
        try:
            sync_client.close()
        except Exception:
            log.exception("Failed closing sync Redis client")
