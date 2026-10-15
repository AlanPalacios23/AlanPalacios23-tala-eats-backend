from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session, selectinload

from .. import models, schemas
from ..config import settings
from ..db import get_db
from ..deps import get_current_user, require_role
from ..http_client import post as http_post
from ..integrations import (
    dispatch_payout,
    geocode,
    integration_status,
    route_estimate,
    verify_payout_webhook,
)
from ..middleware import runtime_metrics
from ..monetization import post_refund_ledger
from ..realtime import driver_location_snapshot, publish_order_event
from ..wallet import credit_wallet, money
from .orders import order_options
from .v9 import _dispatch_candidates

router = APIRouter(prefix="/api/v1/v11", tags=["v11-launch-ready"])


def now() -> datetime:
    return datetime.now(timezone.utc)


def aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def owner_restaurant(db: Session, user: models.User) -> models.Restaurant:
    row = db.scalar(select(models.Restaurant).where(models.Restaurant.owner_id == user.id))
    if not row:
        raise HTTPException(404, "No tienes un restaurante asignado")
    return row


def authorize_order(db: Session, user: models.User, order_id: int, *, lock: bool = False) -> models.Order:
    stmt = select(models.Order).where(models.Order.id == order_id)
    if lock:
        stmt = stmt.with_for_update()
    order = db.scalar(stmt.options(*order_options(), selectinload(models.Order.restaurant)))
    if not order:
        raise HTTPException(404, "Pedido no encontrado")
    allowed = user.role == "admin" or order.user_id == user.id or order.driver_id == user.id
    if user.role == "restaurant" and order.restaurant and order.restaurant.owner_id == user.id:
        allowed = True
    if not allowed:
        raise HTTPException(403, "Sin acceso a este pedido")
    return order


def _setting(db: Session, key: str, default: str) -> str:
    row = db.scalar(select(models.SystemSetting).where(models.SystemSetting.key == key))
    return row.value if row else default


def _canary_percent(db: Session) -> int:
    try:
        return max(0, min(100, int(_setting(db, "v11.canary_percent", str(settings.canary_percent)))))
    except Exception:
        return settings.canary_percent


def _canary_bucket(user_id: int | None, request: Request) -> int:
    source = str(user_id or request.headers.get("x-forwarded-for") or (request.client.host if request.client else "anonymous"))
    return int(hashlib.sha256(source.encode()).hexdigest()[:8], 16) % 100


def _partial_refund(db: Session, order: models.Order, amount: Decimal, reason: str, actor_id: int | None, idempotency_key: str) -> models.RefundAdjustment:
    amount = money(amount)
    existing = db.scalar(select(models.RefundAdjustment).where(models.RefundAdjustment.idempotency_key == idempotency_key))
    if existing:
        return existing
    available = money(Decimal(order.total) - Decimal(order.refunded_amount or 0))
    if amount <= 0 or amount > available:
        raise HTTPException(400, f"Monto inválido. Máximo reembolsable: {available}")
    maximum = money(Decimal(order.total) * Decimal(settings.max_partial_refund_percent) / Decimal(100))
    if amount > maximum:
        raise HTTPException(400, "El reembolso supera la política configurada")

    row = models.RefundAdjustment(
        order_id=order.id,
        created_by_user_id=actor_id,
        amount=amount,
        reason=reason[:300],
        provider=order.payment_method,
        status="pending",
        idempotency_key=idempotency_key,
    )
    db.add(row); db.flush()

    if order.payment_method == "mercadopago":
        if order.payment_status not in {"paid", "partially_refunded"} or not order.payment_provider_id:
            raise HTTPException(409, "No existe un pago Mercado Pago reembolsable")
        if not settings.mercado_pago_access_token:
            raise HTTPException(503, "Mercado Pago no está configurado")
        headers = {
            "Authorization": f"Bearer {settings.mercado_pago_access_token}",
            "Content-Type": "application/json",
            "X-Idempotency-Key": idempotency_key,
        }
        r = http_post(
            f"https://api.mercadopago.com/v1/payments/{order.payment_provider_id}/refunds",
            headers=headers,
            json={"amount": float(amount)},
            timeout=15,
        )
        if not r.ok:
            try: detail = r.json().get("message") or "Mercado Pago rechazó el reembolso parcial"
            except Exception: detail = "Mercado Pago rechazó el reembolso parcial"
            raise HTTPException(502, str(detail)[:300])
        data = r.json()
        row.provider_ref = str(data.get("id") or "")[:220]
        row.status = "completed"
    elif order.payment_method == "stripe":
        from ..stripe_gateway import stripe_client, refund_create, data_dict, money_cents
        if order.payment_status not in {"paid", "partially_refunded"} or not order.payment_provider_id:
            raise HTTPException(409, "No existe un pago Stripe reembolsable")
        if db.scalar(select(models.StripeTransfer.id).where(models.StripeTransfer.order_id == order.id, models.StripeTransfer.status == "completed")):
            raise HTTPException(409, "Hay transferencias Connect; primero conciliar las reversiones")
        try:
            provider_refund = data_dict(refund_create(stripe_client(), order.payment_provider_id, money_cents(amount), idempotency_key))
        except Exception as exc:
            raise HTTPException(502, "Stripe rechazó el reembolso parcial") from exc
        if provider_refund.get("status") != "succeeded":
            raise HTTPException(502, "El reembolso parcial todavía no se completó en Stripe")
        row.provider_ref = str(provider_refund.get("id") or "")[:220]
        row.status = "completed"
    elif order.payment_method in {"wallet", "gift_card"}:
        credit_wallet(
            db,
            order.user_id,
            amount,
            kind="partial_refund",
            reference_type="order",
            reference_id=str(order.id),
            description=reason,
            idempotency_key=f"wallet:{idempotency_key}",
        )
        row.status = "completed"
        row.provider = "tala_wallet"
    elif order.payment_method == "cash":
        # Cash has no remote transfer to reverse. The adjustment is recorded so
        # reconciliation reduces what Tala Eats/driver must collect.
        row.status = "completed"
        row.provider = "cash_reconciliation"
    else:
        raise HTTPException(409, "Este método de pago requiere conciliación manual")

    order.refunded_amount = money(Decimal(order.refunded_amount or 0) + amount)
    if order.refunded_amount >= order.total:
        order.payment_status = "refunded"
    elif order.payment_status in {"paid", "pending"}:
        order.payment_status = "partially_refunded"
    row.completed_at = now()
    post_refund_ledger(db, order, amount, idempotency_suffix=f"partial-{row.id}")
    db.add(models.Notification(user_id=order.user_id, kind="payment", title="Ajuste de tu pedido", message=f"Se procesó un reembolso de ${amount} MXN del pedido #{order.id}."))
    db.add(models.AuditEvent(user_id=actor_id, action="v11.partial_refund", entity_type="order", entity_id=str(order.id), detail=f"amount={amount}; reason={reason}"))
    db.flush()
    return row


@router.get("/overview")
def overview():
    return {
        "version": "11.0.0-launch-ready",
        "theme": "Launch Ready + Scale + Real Integrations",
        "inherits": "V10 Stability + Premium Experience",
        "capabilities": 150,
        "pillars": ["real-payments", "payout-adapters", "push", "maps-routing", "live-orders", "kds-pro", "driver-offers", "canary", "backup-restore", "security", "privacy", "mobile-contract"],
    }


@router.get("/launch-readiness")
def launch_readiness(db: Session = Depends(get_db)):
    integrations = integration_status()
    configured = sum(1 for value in integrations.values() if value.get("configured"))
    return {
        "version": settings.app_version,
        "core_ready": True,
        "integrations": integrations,
        "integrations_configured": configured,
        "integrations_total": len(integrations),
        "privileged_2fa_required": settings.require_privileged_2fa,
        "driver_offer_mode": settings.driver_offer_mode,
        "canary_percent": _canary_percent(db),
        "release_channel": settings.release_channel,
        "go_live": {
            "cash_wallet_core": True,
            "online_payments": integrations["payments"]["configured"],
            "automatic_payouts": integrations["payouts"]["configured"],
            "push": integrations["web_push"]["configured"],
            "real_maps": integrations["maps"]["configured"],
        },
    }


@router.get("/integrations")
def integrations(_: models.User = Depends(require_role("admin"))):
    return integration_status()


@router.get("/release-cohort")
def release_cohort(request: Request, user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    percent = _canary_percent(db)
    bucket = _canary_bucket(user.id, request)
    return {"bucket": bucket, "canary_percent": percent, "channel": "canary" if bucket < percent else "stable", "version": settings.app_version}


@router.put("/admin/canary")
def update_canary(payload: schemas.CanaryWrite, admin: models.User = Depends(require_role("admin")), db: Session = Depends(get_db)):
    row = db.scalar(select(models.SystemSetting).where(models.SystemSetting.key == "v11.canary_percent"))
    if not row:
        row = models.SystemSetting(key="v11.canary_percent", value=str(payload.percent), value_type="integer", description="Porcentaje rollout V11", updated_by_user_id=admin.id)
        db.add(row)
    else:
        row.value = str(payload.percent); row.updated_by_user_id = admin.id
    db.add(models.AuditEvent(user_id=admin.id, action="v11.canary.update", entity_type="system_setting", entity_id="v11.canary_percent", detail=str(payload.percent)))
    db.commit()
    return {"canary_percent": payload.percent}


# ---------------------------------------------------------------------------
# Push notifications
# ---------------------------------------------------------------------------
@router.get("/push/config")
def push_config():
    return {"enabled": bool(settings.web_push_vapid_public_key and settings.web_push_vapid_private_key), "public_key": settings.web_push_vapid_public_key or None}


@router.post("/push/subscriptions", response_model=schemas.PushSubscriptionPublic, status_code=201)
def save_push_subscription(payload: schemas.PushSubscriptionWrite, user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if db.bind and db.bind.dialect.name == "postgresql":
        # Cross-worker serialization prevents two accounts from concurrently
        # claiming the same browser endpoint before either transaction commits.
        db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:endpoint)::bigint)"),
                   {"endpoint": payload.endpoint})
    # Browser push endpoints are effectively bearer capabilities.  A shared
    # browser may sign out and then sign in as a different account while the
    # endpoint remains unchanged: never send both users' order details there.
    for former in db.scalars(select(models.PushSubscription).where(
            models.PushSubscription.endpoint == payload.endpoint,
            models.PushSubscription.user_id != user.id,
            models.PushSubscription.active.is_(True),
    ).with_for_update()):
        former.active = False
    row = db.scalar(select(models.PushSubscription).where(models.PushSubscription.user_id == user.id, models.PushSubscription.endpoint == payload.endpoint))
    if row:
        row.p256dh = payload.p256dh; row.auth = payload.auth; row.platform = payload.platform; row.device_label = payload.device_label; row.active = True
    else:
        row = models.PushSubscription(user_id=user.id, **payload.model_dump()); db.add(row)
    db.commit(); db.refresh(row); return row


@router.delete("/push/subscriptions/{subscription_id}", status_code=204)
def remove_push_subscription(subscription_id: int, user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.get(models.PushSubscription, subscription_id)
    if not row or (user.role != "admin" and row.user_id != user.id):
        raise HTTPException(404, "Suscripción no encontrada")
    row.active = False; db.commit()


# ---------------------------------------------------------------------------
# Maps / geocoding / route ETA
# ---------------------------------------------------------------------------
@router.post("/maps/geocode")
def maps_geocode(payload: schemas.GeocodeRequest, _: models.User = Depends(get_current_user)):
    return {"query": payload.query, "results": geocode(payload.query, payload.limit)}


@router.post("/maps/route")
def maps_route(payload: schemas.RouteEstimateRequest, _: models.User = Depends(get_current_user)):
    return route_estimate(payload.origin_lat, payload.origin_lng, payload.destination_lat, payload.destination_lng)


# ---------------------------------------------------------------------------
# Live Order Experience
# ---------------------------------------------------------------------------
def _customer_driver_location(order: models.Order, user: models.User) -> dict[str, Any] | None:
    """Only the owning customer may view GPS of the CURRENT active delivery driver."""
    if (order.user_id != user.id or user.role != "customer"
            or order.order_type != "delivery"
            or order.status not in {"assigned", "picked_up", "on_the_way"}
            or order.driver_id is None):
        return None
    snapshot = driver_location_snapshot(order.driver_id)
    if snapshot is not None:
        return snapshot
    # Database writes are coalesced and profile.updated_at also changes for
    # non-GPS actions: never invent a GPS observation timestamp/freshness.
    profile = getattr(getattr(order, "driver", None), "driver_profile", None)
    if (profile is None or profile.current_lat is None or profile.current_lng is None):
        return None
    return {"lat": profile.current_lat, "lng": profile.current_lng,
            "reported_at": None, "source": "database", "is_fresh": False}


@router.get("/orders/{order_id}/live")
def live_order(order_id: int, user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    order = authorize_order(db, user, order_id)
    events = db.scalars(select(models.OrderEvent).where(models.OrderEvent.order_id == order.id).order_by(models.OrderEvent.created_at.asc())).all()
    position = _customer_driver_location(order, user)
    # Never route from an old DB coordinate or expose historic driver GPS.
    route = None
    if (position and position["is_fresh"] and order.delivery_lat is not None
            and order.delivery_lng is not None):
        route = route_estimate(position["lat"], position["lng"], order.delivery_lat, order.delivery_lng)
    stages = ["received","confirmed","preparing","ready","assigned","picked_up","on_the_way","delivered"]
    try: current_index = stages.index(order.status)
    except ValueError: current_index = -1
    public_order = (schemas.OrderPublic if order.user_id == user.id else schemas.OrderOperationalPublic).model_validate(order).model_dump(mode="json")
    # The older OrderPublic may embed the driver's DB position; redact it
    # outside an active, authorized delivery even if the mobile UI ignores us.
    driver_info = public_order.get("driver_info")
    if isinstance(driver_info, dict):
        driver_info.pop("current_lat", None)
        driver_info.pop("current_lng", None)
    return {
        "order": public_order,
        "timeline": [{"status": e.status, "at": e.created_at, "metadata": e.metadata_json} for e in events],
        "stages": [{"key": s, "done": current_index >= idx, "active": s == order.status} for idx, s in enumerate(stages)],
        "route": route,
        "driver_location": position,
        "next_action": "rate" if order.status == "delivered" else ("delivery_pin" if order.status == "on_the_way" else "track"),
    }


# ---------------------------------------------------------------------------
# Substitutions / missing items and partial refunds
# ---------------------------------------------------------------------------
@router.post("/merchant/orders/{order_id}/substitutions", response_model=schemas.SubstitutionPublic, status_code=201)
def create_substitution(order_id: int, payload: schemas.SubstitutionCreate, user: models.User = Depends(require_role("restaurant","admin")), db: Session = Depends(get_db)):
    order = authorize_order(db, user, order_id)
    if order.status in {"cancelled","delivered"}:
        raise HTTPException(409, "El pedido ya no admite sustituciones")
    line = db.get(models.OrderItem, payload.order_item_id)
    if not line or line.order_id != order.id:
        raise HTTPException(404, "Artículo no encontrado en el pedido")
    replacement = db.get(models.MenuItem, payload.replacement_menu_item_id) if payload.replacement_menu_item_id else None
    if replacement and replacement.restaurant_id != order.restaurant_id:
        raise HTTPException(400, "El reemplazo debe pertenecer al mismo restaurante")
    original_amount = money(Decimal(line.unit_price) * line.quantity)
    replacement_amount = money(Decimal(replacement.price) * line.quantity) if replacement else Decimal("0.00")
    if replacement_amount > original_amount:
        raise HTTPException(400, "V11 solo permite sustituciones del mismo precio o menores sin un cobro adicional")
    row = models.SubstitutionRequest(
        order_id=order.id, order_item_id=line.id, restaurant_id=order.restaurant_id, requested_by_user_id=user.id,
        replacement_menu_item_id=replacement.id if replacement else None, issue_type=payload.issue_type, message=payload.message,
        original_amount=original_amount, replacement_amount=replacement_amount, expires_at=now()+timedelta(minutes=settings.substitution_response_minutes),
    )
    db.add(row); db.add(models.Notification(user_id=order.user_id, kind="order", title="Tu restaurante necesita una decisión", message=f"Hay un cambio pendiente en el pedido #{order.id}."))
    db.commit(); db.refresh(row); publish_order_event(order.id,"order.substitution",{"substitution_id":row.id,"status":"pending"}); return row


@router.get("/orders/{order_id}/substitutions", response_model=list[schemas.SubstitutionPublic])
def list_substitutions(order_id: int, user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    authorize_order(db, user, order_id)
    return db.scalars(select(models.SubstitutionRequest).where(models.SubstitutionRequest.order_id == order_id).order_by(models.SubstitutionRequest.created_at.desc()).limit(200)).all()


@router.post("/orders/{order_id}/substitutions/{substitution_id}/respond", response_model=schemas.SubstitutionPublic)
def respond_substitution(order_id: int, substitution_id: int, payload: schemas.SubstitutionResolve, user: models.User = Depends(require_role("customer")), db: Session = Depends(get_db)):
    authorized = authorize_order(db, user, order_id)
    order = db.scalar(select(models.Order).where(models.Order.id == authorized.id).with_for_update())
    row = db.scalar(
        select(models.SubstitutionRequest)
        .where(models.SubstitutionRequest.id == substitution_id)
        .with_for_update()
    )
    if not row or row.order_id != order.id or row.status != "pending":
        raise HTTPException(404, "Sustitución pendiente no encontrada")
    if aware(row.expires_at) and aware(row.expires_at) < now():
        row.status = "expired"; db.commit(); raise HTTPException(409, "La solicitud de sustitución expiró")
    line = db.get(models.OrderItem, row.order_item_id)
    if not line:
        raise HTTPException(404, "Artículo original no encontrado")
    refund = Decimal("0.00")
    if payload.action == "accept" and row.replacement_menu_item_id:
        replacement = db.get(models.MenuItem, row.replacement_menu_item_id)
        if not replacement or not replacement.is_available:
            raise HTTPException(409, "El reemplazo ya no está disponible")
        line.menu_item_id = replacement.id; line.name_snapshot = replacement.name; line.unit_price = replacement.price
        refund = money(row.original_amount - row.replacement_amount)
        row.resolution = "replacement_accepted"
    elif payload.action in {"remove_item","reject"}:
        refund = money(row.original_amount); line.quantity = 0; row.resolution = "item_removed"
    elif payload.action == "cancel_order":
        order.status = "cancelled"; order.cancelled_reason = "Cliente canceló por artículo no disponible"; row.resolution = "order_cancelled"
        refund = money(Decimal(order.total) - Decimal(order.refunded_amount or 0))
    if refund > 0 and order.payment_method in {"mercadopago","wallet","gift_card","cash"}:
        _partial_refund(db, order, refund, "Ajuste por sustitución/faltante", user.id, f"substitution:{row.id}:refund")
    row.status = "resolved"; row.resolved_at = now()
    db.commit(); db.refresh(row); publish_order_event(order.id,"order.substitution",{"substitution_id":row.id,"status":"resolved","resolution":row.resolution}); return row


@router.post("/admin/orders/{order_id}/partial-refund", response_model=schemas.RefundAdjustmentPublic)
def partial_refund(order_id: int, payload: schemas.PartialRefundRequest, admin: models.User = Depends(require_role("admin")), db: Session = Depends(get_db)):
    # Serialize financial adjustments for a single order.
    order = db.scalar(select(models.Order).where(models.Order.id == order_id).with_for_update())
    if not order: raise HTTPException(404, "Pedido no encontrado")
    row = _partial_refund(db, order, payload.amount, payload.reason, admin.id, payload.idempotency_key)
    db.commit(); db.refresh(row); publish_order_event(order.id,"payment.partial_refund",{"amount":str(row.amount),"payment_status":order.payment_status}); return row


@router.get("/orders/{order_id}/refunds", response_model=list[schemas.RefundAdjustmentPublic])
def order_refunds(order_id: int, user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    authorize_order(db,user,order_id)
    return db.scalars(select(models.RefundAdjustment).where(models.RefundAdjustment.order_id==order_id).order_by(models.RefundAdjustment.created_at.desc()).limit(200)).all()


# ---------------------------------------------------------------------------
# KDS Pro / driver offers
# ---------------------------------------------------------------------------
@router.get("/merchant/kds-pro")
def kds_pro(user: models.User = Depends(require_role("restaurant","admin")), db: Session = Depends(get_db)):
    r = owner_restaurant(db,user) if user.role != "admin" else db.scalar(select(models.Restaurant).order_by(models.Restaurant.id))
    if not r: return {"restaurant":None,"lanes":{},"stations":{},"sla":{}}
    rows = db.scalars(select(models.Order).where(models.Order.restaurant_id==r.id, models.Order.status.in_(["received","confirmed","preparing","ready"])).options(*order_options()).order_by(models.Order.created_at.asc()).limit(500)).all()
    menu_ids = {line.menu_item_id for o in rows for line in o.items if line.menu_item_id}
    categories = {}
    if menu_ids:
        categories = {row.id: row.category for row in db.scalars(select(models.MenuItem).where(models.MenuItem.id.in_(menu_ids))).all()}
    lanes={s:[] for s in ["received","confirmed","preparing","ready"]}; station_counts={}
    instant=now()
    for o in rows:
        age=max(0,int((instant-aware(o.created_at)).total_seconds()/60)); priority="critical" if age>=35 else ("attention" if age>=20 else "normal")
        item_categories=[]
        for line in o.items:
            cat=categories.get(line.menu_item_id,"General"); item_categories.append(cat); station_counts[cat]=station_counts.get(cat,0)+line.quantity
        lanes[o.status].append({"order":schemas.OrderOperationalPublic.model_validate(o).model_dump(mode="json"),"age_min":age,"priority":priority,"stations":sorted(set(item_categories))})
    prep=[int((aware(o.ready_at)-aware(o.preparing_at)).total_seconds()/60) for o in rows if o.preparing_at and o.ready_at]
    return {"restaurant":{"id":r.id,"name":r.name},"lanes":lanes,"stations":station_counts,"sla":{"open_tickets":len(rows),"oldest_min":max([x["age_min"] for arr in lanes.values() for x in arr],default=0),"avg_prep_min":round(sum(prep)/len(prep),1) if prep else None}}


@router.post("/merchant/orders/{order_id}/bump")
def kds_bump(order_id:int,payload:schemas.KdsBumpRequest,user:models.User=Depends(require_role("restaurant","admin")),db:Session=Depends(get_db)):
    order=authorize_order(db,user,order_id,lock=True); mapping={"confirm":"confirmed","start":"preparing","ready":"ready"}
    if order.payment_method in {"mercadopago", "stripe"} and order.payment_status != "paid":
        raise HTTPException(409,"Mercado Pago aún no confirmó el cobro de este pedido")
    if payload.action=="undo":
        previous={"ready":"preparing","preparing":"confirmed","confirmed":"received"}.get(order.status)
        if not previous: raise HTTPException(409,"No hay un estado anterior disponible")
        new_status=previous
    else:
        new_status=mapping[payload.action]
        expected={"received":"confirmed","confirmed":"preparing","preparing":"ready"}.get(order.status)
        if new_status != expected:
            raise HTTPException(409,f"Transición KDS inválida: {order.status} → {new_status}")
    order.status=new_status; stamp=now()
    if new_status=="confirmed":order.accepted_at=order.accepted_at or stamp
    elif new_status=="preparing":order.preparing_at=order.preparing_at or stamp
    elif new_status=="ready":order.ready_at=stamp
    db.add(models.OrderEvent(order_id=order.id,status=new_status,actor_user_id=user.id,metadata_json=json.dumps({"source":"v11_kds","station":payload.station,"action":payload.action})))
    db.add(models.Notification(user_id=order.user_id,kind="order",title="Tu pedido avanza",message=f"Pedido #{order.id}: {new_status}."));db.commit();publish_order_event(order.id,"order.status",{"status":new_status,"source":"v11-kds"});return {"order_id":order.id,"status":new_status,"station":payload.station}


@router.get("/driver/offers", response_model=list[schemas.DriverOfferPublic])
def driver_offers(user:models.User=Depends(require_role("driver")),db:Session=Depends(get_db)):
    instant=now();rows=db.scalars(select(models.DriverOffer).where(models.DriverOffer.driver_id==user.id,models.DriverOffer.status=="offered",models.DriverOffer.expires_at>instant).order_by(models.DriverOffer.offered_at.desc())).all();return rows


@router.post("/driver/offers/{offer_id}/respond", response_model=schemas.DriverOfferPublic)
def respond_driver_offer(offer_id:int,payload:schemas.DriverOfferResponse,user:models.User=Depends(require_role("driver")),db:Session=Depends(get_db)):
    offer=db.scalar(select(models.DriverOffer).where(models.DriverOffer.id==offer_id,models.DriverOffer.driver_id==user.id).with_for_update())
    if not offer:raise HTTPException(404,"Oferta no encontrada")
    if offer.status!="offered" or aware(offer.expires_at)<=now():
        if offer.status=="offered":offer.status="expired";db.commit()
        raise HTTPException(409,"La oferta ya no está disponible")
    profile = db.scalar(select(models.DriverProfile).where(models.DriverProfile.user_id == user.id).with_for_update())
    if not profile or not profile.is_online or not profile.is_verified:
        raise HTTPException(409,"Debes estar disponible y verificado")
    active = db.scalar(select(models.Order.id).where(models.Order.driver_id == user.id, models.Order.status.in_(["assigned","picked_up","on_the_way"])).limit(1))
    if active:
        raise HTTPException(409,"Ya tienes una entrega activa")
    order=db.scalar(select(models.Order).where(models.Order.id==offer.order_id).with_for_update())
    if not order or order.driver_id is not None or order.status not in {"ready","assigned"}:raise HTTPException(409,"El pedido ya fue tomado")
    offer.responded_at=now();offer.status="accepted" if payload.action=="accept" else "rejected"
    if payload.action=="accept":
        order.driver_id=user.id;order.status="assigned"
        db.query(models.DriverOffer).filter(models.DriverOffer.order_id==order.id,models.DriverOffer.id!=offer.id,models.DriverOffer.status=="offered").update({"status":"expired"},synchronize_session=False)
        db.add(models.OrderEvent(order_id=order.id,status="assigned",actor_user_id=user.id,metadata_json='{"source":"v11_driver_offer"}'))
        db.add(models.Notification(user_id=order.user_id,kind="delivery",title="Repartidor asignado",message=f"Tu pedido #{order.id} ya tiene repartidor."))
    db.commit();db.refresh(offer)
    if payload.action=="accept":publish_order_event(order.id,"order.assigned",{"driver_id":user.id,"source":"v11-offer"})
    return offer


# ---------------------------------------------------------------------------
# Payout execution and provider webhook
# ---------------------------------------------------------------------------
@router.post("/admin/payouts/dispatch")
def dispatch_payouts(payload:schemas.PayoutDispatchRequest,admin:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    results=[]
    for payout_id in payload.payout_ids:
        row=db.get(models.Payout,payout_id)
        if not row:results.append({"id":payout_id,"status":"not_found"});continue
        if row.status=="paid":results.append({"id":payout_id,"status":"already_paid"});continue
        row.attempts=(row.attempts or 0)+1;row.provider=settings.payout_provider
        result=dispatch_payout({"payout_id":row.id,"payee_type":row.payee_type,"payee_id":row.payee_id,"amount":str(row.amount),"currency":row.currency,"period_start":row.period_start.isoformat(),"period_end":row.period_end.isoformat(),"idempotency_key":f"talaeats-payout-{row.id}"})
        if result.ok:
            row.status=result.status if result.status in {"processing","paid","pending"} else "processing";row.provider_ref=result.provider_ref;row.failure_reason=""
            if row.status=="paid":row.paid_at=now()
        else:
            row.status="pending" if result.status in {"manual","not_configured"} else "failed";row.failure_reason=result.detail
        results.append({"id":row.id,"status":row.status,"provider":row.provider,"provider_ref":row.provider_ref,"detail":row.failure_reason})
    db.add(models.AuditEvent(user_id=admin.id,action="v11.payout.dispatch",entity_type="payout_batch",entity_id=",".join(map(str,payload.payout_ids)),detail=json.dumps(results)[:3000]));db.commit();return {"results":results}


@router.post("/payouts/webhook")
async def payout_webhook(request:Request,db:Session=Depends(get_db)):
    raw=await request.body();signature=request.headers.get("x-talaeats-signature") or request.headers.get("x-signature")
    if not verify_payout_webhook(raw,signature):raise HTTPException(401,"Firma de payout inválida")
    try:body=json.loads(raw or b"{}")
    except Exception:raise HTTPException(400,"JSON inválido")
    external_id=str(body.get("event_id") or body.get("id") or secrets.token_hex(12));provider=str(body.get("provider") or settings.payout_provider)
    existing=db.scalar(select(models.IntegrationEvent).where(models.IntegrationEvent.provider==provider,models.IntegrationEvent.external_id==external_id))
    if existing:return {"received":True,"duplicate":True}
    event=models.IntegrationEvent(provider=provider,external_id=external_id,event_type=str(body.get("type") or "payout.updated"),payload=raw.decode(errors="replace")[:8000]);db.add(event)
    payout_id=body.get("payout_id");ref=str(body.get("provider_ref") or body.get("reference") or "")[:180];status=str(body.get("status") or "")[:30]
    row=db.get(models.Payout,int(payout_id)) if str(payout_id).isdigit() else (db.scalar(select(models.Payout).where(models.Payout.provider_ref==ref)) if ref else None)
    if row and status in {"pending","processing","paid","failed"}:
        row.status=status;row.provider_ref=ref or row.provider_ref;row.failure_reason=str(body.get("error") or "")[:500]
        if status=="paid":row.paid_at=now()
    event.status="processed";event.processed_at=now();db.commit();return {"received":True,"duplicate":False}


# ---------------------------------------------------------------------------
# Privacy / security / mobile contract / operations
# ---------------------------------------------------------------------------
@router.get("/privacy/preferences")
def privacy_preferences(user:models.User=Depends(get_current_user)):
    return {"marketing_opt_in":user.marketing_opt_in,"analytics_opt_in":user.analytics_opt_in,"personalization_opt_in":user.personalization_opt_in}


@router.put("/privacy/preferences")
def update_privacy_preferences(payload:schemas.PrivacyPreferencesWrite,user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    for key,value in payload.model_dump(exclude_none=True).items():setattr(user,key,value)
    db.add(models.AuditEvent(user_id=user.id,action="v11.privacy.preferences",entity_type="user",entity_id=str(user.id),detail=json.dumps(payload.model_dump(exclude_none=True))));db.commit();return privacy_preferences(user)


@router.get("/mobile/contract")
def mobile_contract():
    return {
        "api_version":"v1","contract_version":"11.0","minimum_client":"1.0.0","auth":{"cookie_web":True,"bearer_mobile":True},
        "realtime":{"orders":"/ws/orders/{order_id}"},
        "core":{"restaurants":"/api/v1/restaurants","orders":"/api/v1/orders","wallet":"/api/v1/platform/wallet","notifications":"/api/v1/platform/notifications"},
        "v11":{"live_order":"/api/v1/v11/orders/{order_id}/live","driver_offers":"/api/v1/v11/driver/offers","push":"/api/v1/v11/push/subscriptions"},
    }


@router.get("/performance-budgets")
def performance_budgets():
    return {"mobile":{"lcp_ms":2500,"inp_ms":200,"cls":0.1,"initial_js_kb_gzip":220,"initial_css_kb_gzip":90,"image_hero_kb":350},"api":{"p95_ms":1200,"error_rate_percent":1.0,"checkout_p95_ms":1800}}


@router.get("/admin/command-center")
def command_center(admin:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    active_status=["received","confirmed","preparing","ready","assigned","picked_up","on_the_way"]
    active_orders=db.scalar(select(func.count(models.Order.id)).where(models.Order.status.in_(active_status))) or 0
    delayed=db.scalar(select(func.count(models.Order.id)).where(models.Order.status.in_(active_status),models.Order.created_at<now()-timedelta(minutes=45))) or 0
    without_driver=db.scalar(select(func.count(models.Order.id)).where(models.Order.status=="ready",models.Order.driver_id.is_(None))) or 0
    open_incidents=db.scalar(select(func.count(models.OperationalIncident.id)).where(models.OperationalIncident.status=="open")) or 0
    pending_subs=db.scalar(select(func.count(models.SubstitutionRequest.id)).where(models.SubstitutionRequest.status=="pending")) or 0
    payout_failed=db.scalar(select(func.count(models.Payout.id)).where(models.Payout.status=="failed")) or 0
    offers=db.scalar(select(func.count(models.DriverOffer.id)).where(models.DriverOffer.status=="offered",models.DriverOffer.expires_at>now())) or 0
    gross=db.scalar(select(func.coalesce(func.sum(models.Order.total),0)).where(models.Order.status=="delivered")) or 0
    margin=db.scalar(select(func.coalesce(func.sum(models.Order.contribution_margin),0)).where(models.Order.status=="delivered")) or 0
    return {
        "checked_at":now(),"version":settings.app_version,"status":"attention" if delayed or payout_failed or open_incidents else "healthy",
        "operations":{"active_orders":active_orders,"delayed_orders":delayed,"without_driver":without_driver,"open_incidents":open_incidents,"pending_substitutions":pending_subs,"live_driver_offers":offers},
        "finance":{"gmv":str(money(gross)),"contribution_margin":str(money(margin)),"failed_payouts":payout_failed},
        "integrations":integration_status(),"runtime":runtime_metrics.snapshot(),"canary_percent":_canary_percent(db),
    }


@router.post("/admin/driver-offers/{order_id}/create")
def create_driver_offers(order_id:int,admin:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    order=db.get(models.Order,order_id)
    if not order or order.status!="ready" or order.driver_id is not None:raise HTTPException(409,"El pedido no está disponible para ofertar")
    candidates=_dispatch_candidates(order,db)[:5];round_no=(db.scalar(select(func.max(models.DriverOffer.round_no)).where(models.DriverOffer.order_id==order.id)) or 0)+1;created=[]
    for candidate in candidates:
        offer=models.DriverOffer(order_id=order.id,driver_id=candidate["driver_id"],round_no=round_no,score=float(candidate.get("score",0)),estimated_pickup_min=max(3,int(round(float(candidate.get("distance_km",2))*3+4))),estimated_earning=order.driver_earning,expires_at=now()+timedelta(seconds=settings.order_offer_seconds));db.add(offer);created.append(offer);db.add(models.Notification(user_id=offer.driver_id,kind="delivery",title="Nueva oferta de entrega",message=f"Pedido #{order.id} disponible por {settings.order_offer_seconds}s."))
    db.commit();return {"order_id":order.id,"round":round_no,"created":len(created)}
