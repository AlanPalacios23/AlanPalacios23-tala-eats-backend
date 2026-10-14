from __future__ import annotations

from datetime import datetime, timezone
from fastapi import APIRouter, Depends
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from .. import models
from ..config import settings
from ..db import get_db
from ..deps import get_current_user, require_role
from ..middleware import runtime_metrics

router = APIRouter(prefix="/api/v1/v10", tags=["v10-stability-premium"])


def _now():
    return datetime.now(timezone.utc)


def _redis_probe() -> tuple[bool, str | None]:
    if not settings.redis_url:
        return True, None
    try:
        import redis
        client = redis.Redis.from_url(settings.redis_url, decode_responses=True, socket_timeout=1)
        ok = bool(client.ping())
        heartbeat = client.get("talaeats:worker:heartbeat")
        client.close()
        return ok, heartbeat
    except Exception:
        return False, None


@router.get("/overview")
def overview():
    return {
        "version": "10.0.0-stability-premium",
        "theme": "Stability + Premium Experience",
        "inherits": "V9 Intelligence + Growth + Automation",
        "capabilities": 122,
        "stability": {
            "request_deduplication": True,
            "safe_get_retries": True,
            "stale_read_fallback": True,
            "adaptive_websocket_reconnect": True,
            "runtime_health_monitor": True,
            "frontend_error_boundary": True,
            "safe_service_worker": True,
            "production_preflight": True,
        },
    }


@router.get("/runtime")
def runtime(user: models.User = Depends(get_current_user)):
    """Small authenticated runtime signal used by the app shell.

    It intentionally avoids exposing infrastructure secrets or internal hostnames.
    """
    redis_ok, heartbeat = _redis_probe()
    return {
        "status": "ok" if redis_ok else "degraded",
        "version": settings.app_version,
        "role": user.role,
        "redis": "ok" if redis_ok else "degraded",
        "worker": "ok" if heartbeat else ("not-configured" if not settings.redis_url else "starting"),
        "server_time": _now(),
    }


@router.get("/admin/stability")
def stability_center(
    _: models.User = Depends(require_role("admin")),
    db: Session = Depends(get_db),
):
    db_ok = True
    try:
        db.execute(text("SELECT 1"))
    except Exception:
        db_ok = False
    redis_ok, heartbeat = _redis_probe()
    active_orders = db.scalar(
        select(func.count(models.Order.id)).where(
            models.Order.status.in_(["received", "confirmed", "preparing", "ready", "assigned", "picked_up", "on_the_way"])
        )
    ) or 0
    open_incidents = db.scalar(
        select(func.count(models.OperationalIncident.id)).where(models.OperationalIncident.status == "open")
    ) or 0
    online_drivers = db.scalar(
        select(func.count(models.DriverProfile.id)).where(models.DriverProfile.is_online.is_(True))
    ) or 0
    metrics = runtime_metrics.snapshot()
    overall = "healthy"
    if not db_ok or not redis_ok:
        overall = "degraded"
    elif metrics["error_rate_percent"] >= 5 or metrics["p95_ms"] >= settings.slow_request_ms * 2:
        overall = "attention"
    return {
        "status": overall,
        "checked_at": _now(),
        "version": settings.app_version,
        "dependencies": {
            "database": "ok" if db_ok else "error",
            "redis": "ok" if redis_ok else "error",
            "worker": "ok" if heartbeat else ("not-configured" if not settings.redis_url else "starting"),
        },
        "traffic": metrics,
        "operations": {
            "active_orders": active_orders,
            "open_incidents": open_incidents,
            "online_drivers": online_drivers,
        },
        "thresholds": {"slow_request_ms": settings.slow_request_ms, "error_rate_attention_percent": 5},
    }
