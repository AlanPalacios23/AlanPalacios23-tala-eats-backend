from datetime import datetime, timedelta, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .. import models, schemas
from ..config import settings
from ..db import get_db
from ..deps import require_role
from ..delivery_lifecycle import finalize_delivery
from ..finance_core_v2 import driver_cash_eligible
from ..geo import haversine_km
from ..realtime import cache_driver_location, driver_locations, publish_order_event
from .orders import order_options


ACTIVE_DRIVER_STATUSES = {"assigned", "picked_up", "on_the_way"}


def _driver_portal_enabled():
    if settings.merchant_managed_delivery:
        raise HTTPException(
            status_code=410,
            detail="Tala Eats Repartidor no está activo porque MERCHANT_MANAGED_DELIVERY=true",
        )


router = APIRouter(
    prefix="/api/v1/driver",
    tags=["driver"],
    dependencies=[Depends(_driver_portal_enabled)],
)


def _profile(db: Session, user: models.User, *, lock: bool = False) -> models.DriverProfile:
    stmt = select(models.DriverProfile).where(models.DriverProfile.user_id == user.id)
    if lock:
        stmt = stmt.with_for_update()
    profile = db.scalar(stmt)
    if not profile:
        profile = models.DriverProfile(user_id=user.id)
        db.add(profile)
        db.commit()
        db.refresh(profile)
    return profile


def _active_order(db: Session, user_id: int, *, lock: bool = False, eager: bool = True) -> models.Order | None:
    stmt = (
        select(models.Order)
        .where(
            models.Order.driver_id == user_id,
            models.Order.status.in_(ACTIVE_DRIVER_STATUSES),
        )
        .order_by(models.Order.updated_at.asc())
        .limit(1)
    )
    if lock:
        stmt = stmt.with_for_update()
    if eager:
        stmt = stmt.options(*order_options())
    return db.scalar(stmt)


def _delivery_payload(db: Session, order: models.Order) -> dict:
    restaurant = getattr(order, "restaurant", None) or db.get(models.Restaurant, order.restaurant_id)
    customer = getattr(order, "customer", None) or db.get(models.User, order.user_id)
    earning = Decimal(order.driver_earning or 0) + Decimal(order.tip or 0)
    restaurant_address = ""
    if restaurant:
        restaurant_address = (restaurant.address or "").strip() or f"Punto del restaurante · {restaurant.lat:.5f}, {restaurant.lng:.5f}"
    return {
        "id": order.id,
        "code": f"TE-{order.id:04d}",
        "status": order.status,
        "restaurant": {
            "id": restaurant.id if restaurant else order.restaurant_id,
            "name": restaurant.name if restaurant else "Restaurante",
            "address": restaurant_address,
            "lat": restaurant.lat if restaurant else None,
            "lng": restaurant.lng if restaurant else None,
        },
        "customer": {
            "id": customer.id if customer else order.user_id,
            "name": customer.name if customer else "Cliente",
            "phone": customer.phone if customer else "",
            "address": order.address,
            "lat": order.delivery_lat,
            "lng": order.delivery_lng,
        },
        "total": float(order.total or 0),
        "earning": float(earning),
        "distance_km": float(order.distance_km or 0),
        "eta_minutes": int(order.estimated_minutes or 0),
        "note": order.notes or "",
        "created_at": order.created_at.isoformat() if order.created_at else None,
        "delivered_at": order.delivered_at.isoformat() if order.delivered_at else None,
    }


def _assign_oldest_ready_to_driver(db: Session, user: models.User) -> models.Order | None:
    """Atomically claim one ready delivery for one online/verified driver.

    The driver profile row is locked first, so two concurrent requests for the same
    driver cannot claim two orders. Candidate order rows are then claimed with
    SKIP LOCKED on PostgreSQL so different drivers can continue without waiting.
    """
    profile = _profile(db, user, lock=True)
    if not profile.is_online or not profile.is_verified:
        return None
    if _active_order(db, user.id, lock=True, eager=False):
        return None

    candidates = db.scalars(
        select(models.Order)
        .where(
            models.Order.status == "ready",
            models.Order.driver_id.is_(None),
            models.Order.order_type == "delivery",
        )
        .options(selectinload(models.Order.restaurant))
        .order_by(models.Order.ready_at.asc(), models.Order.updated_at.asc(), models.Order.id.asc())
        .limit(25)
    ).all()
    if not candidates:
        return None

    cached = driver_locations([user.id]).get(user.id)
    driver_lat = cached[0] if cached else profile.current_lat
    driver_lng = cached[1] if cached else profile.current_lng

    def score(order: models.Order):
        restaurant = order.restaurant
        if restaurant and driver_lat is not None and driver_lng is not None:
            distance = haversine_km(driver_lat, driver_lng, restaurant.lat, restaurant.lng)
        else:
            distance = 9999.0
        return (distance, order.ready_at or order.updated_at, order.id)

    for candidate in sorted(candidates, key=score):
        current = db.scalar(
            select(models.Order)
            .where(models.Order.id == candidate.id)
            .with_for_update(skip_locked=True)
        )
        if not current or current.status != "ready" or current.driver_id is not None:
            continue
        if settings.finance_v2_shadow_enabled and not driver_cash_eligible(db, user.id, current):
            continue
        current.driver_id = user.id
        current.status = "assigned"
        db.add(models.OrderEvent(order_id=current.id, status="assigned", actor_user_id=user.id, metadata_json='{"source":"driver_online_auto_claim"}'))
        db.add(models.Notification(user_id=user.id, kind="delivery", title="Nueva entrega asignada", message=f"Pedido #{current.id} listo para recoger."))
        db.add(models.Notification(user_id=current.user_id, kind="delivery", title="Repartidor asignado", message=f"Ya asignamos repartidor a tu pedido #{current.id}."))
        db.commit()
        publish_order_event(current.id, "order.assigned", {"driver_id": user.id, "status": "assigned"})
        return db.scalar(select(models.Order).where(models.Order.id == current.id).options(*order_options()))
    db.rollback()
    return None


@router.get("/profile", response_model=schemas.DriverProfilePublic)
def profile(
    user: models.User = Depends(require_role("driver")),
    db: Session = Depends(get_db),
):
    return _profile(db, user)


@router.get("/dashboard")
def dashboard(
    user: models.User = Depends(require_role("driver")),
    db: Session = Depends(get_db),
):
    profile = _profile(db, user)
    active = _active_order(db, user.id)
    recent = db.scalars(
        select(models.Order)
        .where(
            models.Order.driver_id == user.id,
            models.Order.status == "delivered",
        )
        .options(*order_options())
        .order_by(models.Order.delivered_at.desc(), models.Order.updated_at.desc())
        .limit(20)
    ).all()

    now = datetime.now(timezone.utc)
    today = now.date()
    week_start = datetime.combine(today - timedelta(days=6), datetime.min.time(), tzinfo=timezone.utc)
    week_rows = db.execute(
        select(models.Order.delivered_at, models.Order.driver_earning, models.Order.tip, models.Order.distance_km)
        .where(
            models.Order.driver_id == user.id,
            models.Order.status == "delivered",
            models.Order.delivered_at >= week_start,
        )
        .order_by(models.Order.delivered_at.asc())
    ).all()
    by_day = {}
    for delivered_at, driver_earning, tip, distance_km in week_rows:
        if not delivered_at:
            continue
        instant = delivered_at if delivered_at.tzinfo else delivered_at.replace(tzinfo=timezone.utc)
        bucket = by_day.setdefault(instant.date(), {"earnings": Decimal("0"), "deliveries": 0, "distance_km": 0.0})
        bucket["earnings"] += Decimal(driver_earning or 0) + Decimal(tip or 0)
        bucket["deliveries"] += 1
        bucket["distance_km"] += float(distance_km or 0)
    today_bucket = by_day.get(today, {"earnings": Decimal("0"), "deliveries": 0, "distance_km": 0.0})
    today_earnings = today_bucket["earnings"]
    today_distance = today_bucket["distance_km"]

    seven_days = []
    for offset in range(6, -1, -1):
        date = today - timedelta(days=offset)
        bucket = by_day.get(date, {"earnings": Decimal("0"), "deliveries": 0})
        seven_days.append({"date": date.isoformat(), "earnings": float(bucket["earnings"]), "deliveries": bucket["deliveries"]})

    return {
        "user": {
            "id": user.id,
            "name": user.name,
            "phone": user.phone,
            "avatar_url": user.avatar_url,
        },
        "profile": schemas.DriverProfilePublic.model_validate(profile).model_dump(mode="json"),
        "active": _delivery_payload(db, active) if active else None,
        "recent": [_delivery_payload(db, order) for order in recent],
        "today": {
            "earnings": float(today_earnings),
            "deliveries": today_bucket["deliveries"],
            "distance_km": round(today_distance, 2),
            "average_earning": float(today_earnings / today_bucket["deliveries"]) if today_bucket["deliveries"] else 0.0,
        },
        # Current production model auto-assigns work and does not expose reject/decline yet.
        "acceptance_rate": 100,
        "last_7_days": seven_days,
    }


@router.patch("/availability", response_model=schemas.DriverProfilePublic)
def availability(
    payload: schemas.DriverAvailabilityUpdate,
    user: models.User = Depends(require_role("driver")),
    db: Session = Depends(get_db),
):
    profile = _profile(db, user)
    if not payload.is_online and _active_order(db, user.id):
        raise HTTPException(409, "Finaliza la entrega activa antes de desconectarte")
    profile.is_online = payload.is_online
    db.commit()
    db.refresh(profile)
    if payload.is_online:
        _assign_oldest_ready_to_driver(db, user)
    return profile


@router.patch("/location", response_model=schemas.DriverProfilePublic)
def location(
    payload: schemas.DriverLocationUpdate,
    user: models.User = Depends(require_role("driver")),
    db: Session = Depends(get_db),
):
    profile = _profile(db, user)
    # GPS may arrive every few seconds. Keep every sample in Redis for dispatch/realtime,
    # while coalescing PostgreSQL writes to avoid turning location pings into a DB hotspot.
    persist_to_db = cache_driver_location(user.id, payload.lat, payload.lng)
    profile.current_lat = payload.lat
    profile.current_lng = payload.lng
    if persist_to_db:
        db.commit()
        db.refresh(profile)
    active = db.scalar(
        select(models.Order)
        .where(models.Order.driver_id == user.id, models.Order.status.in_(ACTIVE_DRIVER_STATUSES))
        .options(selectinload(models.Order.restaurant))
        .order_by(models.Order.updated_at.asc())
        .limit(1)
    )
    if active:
        data = {"lat": payload.lat, "lng": payload.lng}
        restaurant = active.restaurant
        if restaurant:
            to_restaurant = haversine_km(payload.lat, payload.lng, restaurant.lat, restaurant.lng)
            data["distance_to_restaurant_km"] = round(to_restaurant, 3)
            if to_restaurant <= 0.12 and active.status == "assigned":
                data["geofence"] = "at_restaurant"
        if active.delivery_lat is not None and active.delivery_lng is not None:
            to_customer = haversine_km(payload.lat, payload.lng, active.delivery_lat, active.delivery_lng)
            data["distance_to_customer_km"] = round(to_customer, 3)
            if to_customer <= 0.18 and active.status == "on_the_way":
                data["geofence"] = "near_customer"
        publish_order_event(active.id, "driver.location", data)
    return profile


@router.get("/available", response_model=list[schemas.OrderOperationalPublic])
def available(
    limit: int = Query(default=25, ge=1, le=100),
    user: models.User = Depends(require_role("driver")),
    db: Session = Depends(get_db),
):
    if not _profile(db, user).is_online or _active_order(db, user.id):
        return []
    candidates = db.scalars(
        select(models.Order)
        .where(
            models.Order.status == "ready",
            models.Order.driver_id.is_(None),
            models.Order.order_type == "delivery",
        )
        .options(*order_options())
        .order_by(models.Order.updated_at.asc())
        .limit(limit)
    ).all()
    if not settings.finance_v2_shadow_enabled:
        return candidates
    return [order for order in candidates if driver_cash_eligible(db, user.id, order)]


@router.get("/mine", response_model=list[schemas.OrderOperationalPublic])
def mine(
    limit: int = Query(default=100, ge=1, le=200),
    user: models.User = Depends(require_role("driver")),
    db: Session = Depends(get_db),
):
    return db.scalars(
        select(models.Order)
        .where(models.Order.driver_id == user.id)
        .options(*order_options())
        .order_by(models.Order.updated_at.desc())
        .limit(limit)
    ).all()


@router.post("/orders/{order_id}/accept", response_model=schemas.OrderOperationalPublic)
def accept(
    order_id: int,
    user: models.User = Depends(require_role("driver")),
    db: Session = Depends(get_db),
):
    profile = _profile(db, user, lock=True)
    if not profile.is_online or not profile.is_verified:
        raise HTTPException(400, "Debes estar disponible y verificado")
    active = _active_order(db, user.id, lock=True, eager=False)
    if active:
        raise HTTPException(409, "Ya tienes una entrega activa")
    order = db.scalar(
        select(models.Order)
        .where(models.Order.id == order_id)
        .with_for_update()
    )
    if not order:
        raise HTTPException(404, "Pedido no encontrado")
    if order.status != "ready" or order.driver_id is not None:
        raise HTTPException(409, "Pedido no disponible")
    if settings.finance_v2_shadow_enabled and not driver_cash_eligible(db, user.id, order):
        raise HTTPException(409, "Límite de efectivo alcanzado; acepta pedidos digitales")
    order.driver_id = user.id
    order.status = "assigned"
    db.add(
        models.OrderEvent(
            order_id=order.id,
            status="assigned",
            actor_user_id=user.id,
            metadata_json='{"source":"driver_accept"}',
        )
    )
    db.add(
        models.Notification(
            user_id=order.user_id,
            kind="delivery",
            title="Repartidor asignado",
            message=f"Ya asignamos repartidor a tu pedido #{order.id}.",
        )
    )
    db.commit()
    publish_order_event(order.id, "order.assigned", {"driver_id": user.id, "status": order.status})
    return db.scalar(select(models.Order).where(models.Order.id == order.id).options(*order_options()))


@router.patch("/orders/{order_id}/status", response_model=schemas.OrderOperationalPublic)
def status(
    order_id: int,
    payload: schemas.OrderStatusUpdate,
    user: models.User = Depends(require_role("driver")),
    db: Session = Depends(get_db),
):
    order = db.scalar(select(models.Order).where(models.Order.id == order_id).with_for_update())
    if not order:
        raise HTTPException(404, "Pedido no encontrado")
    if order.driver_id != user.id:
        raise HTTPException(403, "Pedido no asignado")

    expected = {
        "assigned": "picked_up",
        "picked_up": "on_the_way",
    }.get(order.status)
    if not expected or payload.status != expected:
        raise HTTPException(409, f"Transición inválida: {order.status} → {payload.status}")

    order.status = payload.status
    if payload.status == "picked_up":
        order.picked_up_at = datetime.now(timezone.utc)
    db.add(
        models.OrderEvent(
            order_id=order.id,
            status=payload.status,
            actor_user_id=user.id,
            metadata_json='{"source":"driver"}',
        )
    )
    db.add(
        models.Notification(
            user_id=order.user_id,
            kind="delivery",
            title="Tu repartidor avanza",
            message=f"Pedido #{order.id}: {payload.status}.",
        )
    )
    db.commit()
    publish_order_event(order.id, "order.status", {"status": payload.status, "driver_id": user.id})
    return db.scalar(select(models.Order).where(models.Order.id == order.id).options(*order_options()))


@router.post("/orders/{order_id}/complete", response_model=schemas.OrderOperationalPublic)
def complete(
    order_id: int,
    payload: schemas.DeliveryCompleteRequest,
    user: models.User = Depends(require_role("driver")),
    db: Session = Depends(get_db),
):
    order = db.scalar(select(models.Order).where(models.Order.id == order_id).with_for_update())
    if not order:
        raise HTTPException(404, "Pedido no encontrado")
    if order.driver_id != user.id:
        raise HTTPException(403, "Pedido no asignado")
    if order.status != "on_the_way":
        raise HTTPException(409, "Primero marca el pedido como en camino")
    if payload.pin != order.delivery_pin:
        raise HTTPException(400, "PIN incorrecto")
    finalize_delivery(
        db,
        order,
        user.id,
        "delivery_pin",
        payload.photo_url,
        payload.lat,
        payload.lng,
        True,
    )
    # Keep the driver online and immediately claim the next waiting delivery, if any.
    _assign_oldest_ready_to_driver(db, user)
    return db.scalar(select(models.Order).where(models.Order.id == order.id).options(*order_options()))
