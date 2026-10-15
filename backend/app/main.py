import asyncio
import logging
import time
from threading import Lock
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from sqlalchemy import text

from .config import settings
from .db import Base, SessionLocal, engine
from .middleware import OriginGuardMiddleware, RateLimitMiddleware, IdempotencyMiddleware, RequestContextMiddleware, RequestSizeLimitMiddleware, close_runtime_clients
from .realtime import close_realtime_clients, order_pubsub, redis_ping
from .routes import admin, auth, driver, orders, owner, payments, platform, restaurants, uploads, operations, v9, v10, v11, resilience
from .deps import user_from_access_token
from .seed import seed_database
from . import models
from . import core_resilience  # noqa: F401 - registers global state/outbox guards
from .order_state import InvalidOrderTransition

logging.basicConfig(level=logging.INFO, format="%(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings.validate_production()
    settings.media_dir.mkdir(parents=True, exist_ok=True)
    if not settings.is_production:
        Base.metadata.create_all(bind=engine)
    if settings.seed_demo_data:
        with SessionLocal() as db:
            seed_database(db)
    try:
        yield
    finally:
        await close_runtime_clients()
        await close_realtime_clients()


settings.media_dir.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    lifespan=lifespan,
    docs_url="/docs" if settings.docs_enabled else None,
    redoc_url=None,
)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts)
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True, allow_methods=["GET","POST","PUT","PATCH","DELETE","OPTIONS"], allow_headers=["Authorization","Content-Type","X-Request-ID","X-TalaEats-Client","X-TalaEats-Version","X-Device-ID","X-Device-Token","Idempotency-Key"])
app.add_middleware(OriginGuardMiddleware)
app.add_middleware(RateLimitMiddleware)
app.add_middleware(IdempotencyMiddleware)
app.add_middleware(RequestSizeLimitMiddleware)
app.add_middleware(RequestContextMiddleware)

from .routes import stripe_payments
from .routes import finance_v2
from .routes import withdrawals
from . import native_push
for router in [auth.router, restaurants.router, orders.router, owner.router, driver.router, admin.router, platform.router, payments.router, stripe_payments.router, withdrawals.router, native_push.router, finance_v2.router, uploads.router, operations.router, v9.router, v10.router, v11.router, resilience.router]:
    app.include_router(router)

try:
    from .integrations import setup_optional_otel
    setup_optional_otel(app)
except Exception:
    logging.getLogger("talaeats.otel").exception("Optional OTel initialization failed")


@app.get("/")
def root():
    return {
        "service": "Tala Eats API",
        "version": settings.app_version,
        "environment": settings.environment,
        "product_scope": "customer-restaurant-driver-admin",
        "merchant_managed_delivery": settings.merchant_managed_delivery,
        "driver_portal_enabled": not settings.merchant_managed_delivery,
        "online_payments_required": settings.require_online_payments,
        "v1_production_ready": bool(
            not settings.is_production
            or (
                not settings.merchant_managed_delivery
                and (not settings.require_online_payments or bool(settings.mercado_pago_access_token or (settings.stripe_enabled and settings.stripe_secret_key and settings.stripe_webhook_secret)))
            )
        ),
        "hardening_revision": settings.hardening_revision,
        "core_resilience": True,
        "durable_outbox": True,
        "state_machine": True,
        "immutable_ledger": settings.immutable_ledger,
    }


_health_cache = {"at": 0.0, "db_ok": False, "redis_ok": False, "worker_heartbeat": None}
_health_lock = Lock()


def _dependency_health() -> tuple[bool, bool, str | None]:
    now = time.monotonic()
    with _health_lock:
        if settings.health_cache_seconds and now - _health_cache["at"] < settings.health_cache_seconds:
            return _health_cache["db_ok"], _health_cache["redis_ok"], _health_cache["worker_heartbeat"]
    db_ok = False
    try:
        with SessionLocal() as db:
            db.execute(text("SELECT 1"))
            db_ok = True
    except Exception:
        logging.getLogger("talaeats.health").exception("Database health check failed")
    redis_ok, worker_heartbeat = redis_ping()
    with _health_lock:
        _health_cache.update({"at": now, "db_ok": db_ok, "redis_ok": redis_ok, "worker_heartbeat": worker_heartbeat})
    return db_ok, redis_ok, worker_heartbeat


@app.get("/api/v1/health")
def health():
    db_ok, redis_ok, worker_heartbeat = _dependency_health()
    status = "ok" if db_ok and redis_ok else "degraded"
    return {
        "status": status,
        "service": "tala-eats-api",
        "version": settings.app_version,
        "database": "ok" if db_ok else "error",
        "redis": "ok" if redis_ok else "error",
        "worker": "ok" if worker_heartbeat else ("not-configured" if not settings.redis_url else "starting"),
        "worker_heartbeat": worker_heartbeat,
        "payments": "configured" if settings.mercado_pago_access_token or (settings.stripe_enabled and settings.stripe_secret_key and settings.stripe_webhook_secret) else "not-configured",
        "google": "configured" if settings.google_client_id else "optional-not-configured",
        "email": "configured" if settings.smtp_host else "optional-not-configured",
        "wallet": "configured",
        "websocket": "configured" if settings.redis_url else "local-only",
        "customer_ready": bool(db_ok and redis_ok),
        "core_checkout": "ready",
        "features": 170,
        "operations": "configured",
        "finance_ledger": "configured",
        "simulation_mode": "configured",
        "ux_v7_ready": True,
        "app_experience_v8_ready": True,
        "intelligence_v9_ready": True,
        "growth_v9_ready": True,
        "automation_v9_ready": True,
        "stability_v10_ready": True,
        "premium_v10_ready": True,
        "launch_v11_ready": True,
        "real_integrations_v11_ready": True,
        "mobile_contract_v11_ready": True,
        "massive_traffic_hardening": True,
        "core_resilience_v14": True,
        "stripe_wallets_extension_v15": True,
        "stripe_enabled": bool(settings.stripe_enabled and settings.stripe_secret_key and settings.stripe_webhook_secret),
        "durable_outbox": True,
        "dead_letter_queue": True,
        "payment_reconciliation": True,
        "immutable_ledger": settings.immutable_ledger,
        "dispatch_v2": True,
        "catalog_cache": bool(settings.redis_url),
        "read_replica_configured": bool(settings.read_database_url),
        "postgis_enabled": settings.postgis_enabled,
        "hardening_revision": settings.hardening_revision,
        "product_scope": "customer-restaurant-driver-admin",
        "merchant_managed_delivery": settings.merchant_managed_delivery,
        "driver_portal_enabled": not settings.merchant_managed_delivery,
        "online_payments_required": settings.require_online_payments,
        "v1_production_ready": bool(
            db_ok
            and redis_ok
            and (not settings.is_production or not settings.merchant_managed_delivery)
            and (not settings.require_online_payments or bool(settings.mercado_pago_access_token or (settings.stripe_enabled and settings.stripe_secret_key and settings.stripe_webhook_secret)))
        ),
    }


@app.get("/api/v1/ready")
def readiness():
    db_ok, redis_ok, _ = _dependency_health()
    code = 200 if db_ok and redis_ok else 503
    return JSONResponse({
        "ready": bool(db_ok and redis_ok),
        "database": db_ok,
        "redis": redis_ok,
        "version": settings.app_version,
        "product_scope": "customer-restaurant-driver-admin",
        "merchant_managed_delivery": settings.merchant_managed_delivery,
        "online_payments_required": settings.require_online_payments,
        "driver_portal_enabled": not settings.merchant_managed_delivery,
        "massive_traffic_hardening": True,
        "core_resilience_v14": True,
        "stripe_wallets_extension_v15": True,
        "stripe_enabled": bool(settings.stripe_enabled and settings.stripe_secret_key and settings.stripe_webhook_secret),
        "durable_outbox": True,
        "payment_reconciliation": True,
        "hardening_revision": settings.hardening_revision,
    }, status_code=code)


@app.exception_handler(InvalidOrderTransition)
async def invalid_order_transition_handler(request: Request, exc: InvalidOrderTransition):
    request_id = getattr(request.state, "request_id", "unknown")
    return JSONResponse({"detail": str(exc), "request_id": request_id}, status_code=409, headers={"X-Request-ID": request_id})


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    request_id = getattr(request.state, "request_id", "unknown")
    logging.getLogger("talaeats.error").exception("Unhandled error request_id=%s path=%s", request_id, request.url.path)
    return JSONResponse(
        {"detail": "Tala Eats encontró un error inesperado. Intenta nuevamente.", "request_id": request_id},
        status_code=500,
        headers={"X-Request-ID": request_id},
    )

def _ws_authorized(order: models.Order, user: models.User, db) -> bool:
    if user.role == "admin" or order.user_id == user.id or order.driver_id == user.id:
        return True
    if user.role == "restaurant":
        rest = db.get(models.Restaurant, order.restaurant_id)
        return bool(rest and rest.owner_id == user.id)
    return False


@app.websocket("/ws/orders/{order_id}")
async def order_socket(websocket: WebSocket, order_id: int):
    authorization = websocket.headers.get("authorization", "")
    bearer_token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    token = bearer_token or websocket.cookies.get(settings.session_cookie_name) or websocket.query_params.get("token")
    if not token:
        await websocket.close(code=4401); return
    try:
        with SessionLocal() as db:
            user = user_from_access_token(db, token)
            order = db.get(models.Order, order_id)
            if not order or not _ws_authorized(order, user, db):
                await websocket.close(code=4403); return
    except Exception:
        await websocket.close(code=4401); return

    await websocket.accept()
    pubsub = await order_pubsub(order_id)
    try:
        await websocket.send_json({"order_id": order_id, "event": "connected"})
        while True:
            if pubsub:
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=18)
                if message and message.get("data"):
                    await websocket.send_text(message["data"])
                else:
                    await websocket.send_json({"order_id": order_id, "event": "heartbeat"})
            else:
                await asyncio.sleep(8)
                await websocket.send_json({"order_id": order_id, "event": "heartbeat"})
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        if pubsub:
            await pubsub.unsubscribe(f"talaeats:order:{order_id}"); await pubsub.aclose()
