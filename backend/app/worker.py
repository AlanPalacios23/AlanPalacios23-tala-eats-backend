from __future__ import annotations

import logging
import secrets
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from . import models
from . import core_resilience  # noqa: F401 - same domain guards as API
from .config import settings
from .db import SessionLocal
from .email_service import send_pending_emails
from .feature_flags import enabled as feature_enabled
from .integrations import send_web_push
from .native_push import deliver_native_push, PROMOTIONAL_KINDS
from .inventory import restore_orders_inventory
from .outbox import process_outbox
from .reconciliation import reconcile_mercadopago
from .alerting import evaluate_system_alerts
from .resilience_maintenance import cleanup_resilience_history
from .realtime import publish_order_event

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("talaeats.worker")

_ACTIVE_DELIVERY_STATUSES = ("assigned", "picked_up", "on_the_way")
_worker_redis = None


def _redis_client():
    global _worker_redis
    if _worker_redis is None and settings.redis_url:
        import redis

        _worker_redis = redis.Redis.from_url(
            settings.redis_url,
            decode_responses=True,
            max_connections=settings.redis_max_connections,
            socket_timeout=settings.redis_socket_timeout_seconds,
            socket_connect_timeout=settings.redis_socket_timeout_seconds,
            health_check_interval=30,
        )
    return _worker_redis


def _acquire_cycle_lock() -> str | None:
    client = _redis_client()
    if client is None:
        # Development/SQLite can run without Redis. Production validation requires it.
        return "local-development"
    token = secrets.token_hex(16)
    try:
        ok = client.set(
            "talaeats:worker:cycle-lock",
            token,
            nx=True,
            ex=settings.worker_lock_ttl_seconds,
        )
        return token if ok else None
    except Exception:
        log.exception("worker lock acquisition failed")
        return None


def _refresh_cycle_lock(token: str | None) -> None:
    if not token or token == "local-development":
        return
    client = _redis_client()
    if client is None:
        return
    try:
        client.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then "
            "return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end",
            1,
            "talaeats:worker:cycle-lock",
            token,
            settings.worker_lock_ttl_seconds,
        )
    except Exception:
        log.exception("worker lock refresh failed")


def _release_cycle_lock(token: str | None) -> None:
    if not token or token == "local-development":
        return
    client = _redis_client()
    if client is None:
        return
    try:
        client.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then "
            "return redis.call('del', KEYS[1]) else return 0 end",
            1,
            "talaeats:worker:cycle-lock",
            token,
        )
    except Exception:
        log.exception("worker lock release failed")


def write_heartbeat() -> None:
    client = _redis_client()
    if client is None:
        return
    try:
        client.set(
            "talaeats:worker:heartbeat",
            datetime.now(timezone.utc).isoformat(),
            ex=max(180, settings.worker_interval_seconds * 6),
        )
    except Exception:
        log.exception("worker heartbeat failed")


def _scheduled_due(key: str, interval_seconds: int) -> bool:
    client = _redis_client()
    if client is None:
        # Development fallback: worker is single process.
        return int(time.time()) % max(1, interval_seconds) < settings.worker_interval_seconds
    try:
        return bool(client.set(f"talaeats:worker:schedule:{key}", "1", nx=True, ex=max(1, interval_seconds)))
    except Exception:
        log.exception("scheduled gate failed key=%s", key)
        return False


def _release_inventory_batch(db, orders: list[models.Order]) -> None:
    # Shared cancellation/refund logic restores both menu stock and recipe ingredients.
    restore_orders_inventory(db, orders)


def expire_unpaid_orders() -> int:
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=settings.payment_reservation_minutes)
    with SessionLocal() as db:
        rows = db.scalars(
            select(models.Order)
            .options(selectinload(models.Order.items))
            .where(
                models.Order.payment_method.in_(("mercadopago", "stripe")),
                models.Order.payment_status == "pending",
                models.Order.status == "received",
                models.Order.created_at < cutoff,
            )
            .order_by(models.Order.created_at)
            .limit(settings.worker_batch_size)
            .with_for_update(skip_locked=True)
        ).all()
        if not rows:
            return 0
        _release_inventory_batch(db, rows)
        event_ids = []
        for order in rows:
            order.status = "cancelled"
            order.payment_status = "expired"
            order.cancelled_reason = "Reserva de inventario vencida sin pago confirmado"
            db.add(
                models.Notification(
                    user_id=order.user_id,
                    kind="payment",
                    title="Pago no completado",
                    message=f"El pedido #{order.id} venció porque el pago no fue confirmado.",
                )
            )
            event_ids.append(order.id)
        db.commit()
    for order_id in event_ids:
        publish_order_event(order_id, "payment.expired", {"payment_status": "expired", "status": "cancelled"})
    return len(event_ids)


def cleanup_orphan_proofs() -> int:
    directory = settings.media_dir / "delivery-proofs"
    if not directory.exists():
        return 0
    cutoff = time.time() - 24 * 3600
    removed = 0
    candidates = [path for path in directory.iterdir() if path.is_file() and path.stat().st_mtime < cutoff]
    if not candidates:
        return 0
    # Query only old on-disk candidates instead of materializing every proof URL ever stored.
    with SessionLocal() as db:
        referenced = set()
        for start in range(0, len(candidates), 500):
            chunk = candidates[start : start + 500]
            urls = [f"/api/v1/uploads/delivery-proof/{path.name}" for path in chunk]
            referenced.update(db.scalars(select(models.DeliveryProof.photo_url).where(models.DeliveryProof.photo_url.in_(urls))).all())
    for path in candidates:
        url = f"/api/v1/uploads/delivery-proof/{path.name}"
        if url not in referenced:
            path.unlink(missing_ok=True)
            removed += 1
    return removed


def notify_scheduled_orders() -> int:
    instant = datetime.now(timezone.utc)
    horizon = instant + timedelta(minutes=settings.schedule_prep_lead_minutes)
    with SessionLocal() as db:
        rows = db.scalars(
            select(models.Order)
            .where(
                models.Order.scheduled_for.is_not(None),
                models.Order.scheduled_for <= horizon,
                models.Order.status == "received",
            )
            .order_by(models.Order.scheduled_for)
            .limit(settings.worker_batch_size)
            .with_for_update(skip_locked=True)
        ).all()
        if not rows:
            return 0
        markers = [f"scheduled-prep:{order.id}" for order in rows]
        existing = set(
            db.scalars(select(models.AuditEvent.action).where(models.AuditEvent.action.in_(markers))).all()
        )
        count = 0
        for order in rows:
            marker = f"scheduled-prep:{order.id}"
            if marker in existing:
                continue
            db.add(
                models.AuditEvent(
                    user_id=order.user_id,
                    action=marker,
                    entity_type="order",
                    entity_id=str(order.id),
                    detail="Pedido programado entró a ventana de preparación",
                )
            )
            db.add(
                models.Notification(
                    user_id=order.user_id,
                    kind="order",
                    title="Tu pedido programado se acerca",
                    message=f"El pedido #{order.id} ya entró a la ventana de preparación.",
                )
            )
            count += 1
        db.commit()
    return count


def _claim_available_driver(db, candidates: list[dict], *, exclude: int | None = None) -> int | None:
    for candidate in candidates:
        driver_id = int(candidate["driver_id"])
        if exclude is not None and driver_id == exclude:
            continue
        profile = db.scalar(
            select(models.DriverProfile)
            .where(
                models.DriverProfile.user_id == driver_id,
                models.DriverProfile.is_online.is_(True),
                models.DriverProfile.is_verified.is_(True),
            )
            .with_for_update(skip_locked=True)
        )
        if not profile:
            continue
        busy = db.scalar(
            select(models.Order.id)
            .where(
                models.Order.driver_id == driver_id,
                models.Order.status.in_(_ACTIVE_DELIVERY_STATUSES),
            )
            .limit(1)
        )
        if not busy:
            return driver_id
    return None


def automate_v9_operations() -> tuple[int, int, int]:
    """Bounded auto-dispatch/reassignment with row-level concurrency control."""
    assigned = reassigned = incentives = 0
    instant = datetime.now(timezone.utc)
    published: list[tuple[int, int, str]] = []
    with SessionLocal() as db:
        from .routes.v9 import _aware, _dispatch_candidates

        active = db.scalars(
            select(models.Order)
            .where(models.Order.status.in_(("ready", "assigned", "picked_up", "on_the_way")))
            .order_by(models.Order.updated_at)
            .limit(settings.worker_batch_size)
            .with_for_update(skip_locked=True)
        ).all()
        for order in active:
            age = (instant - _aware(order.updated_at)).total_seconds() / 60
            if order.status == "ready" and order.driver_id is None and age >= 5 and not settings.driver_offer_mode:
                candidates = _dispatch_candidates(order, db)
                driver_id = _claim_available_driver(db, candidates)
                if driver_id:
                    order.driver_id = driver_id
                    order.status = "assigned"
                    db.add(
                        models.OrderEvent(
                            order_id=order.id,
                            status="assigned",
                            actor_user_id=None,
                            metadata_json='{"source":"v9_worker_auto_dispatch"}',
                        )
                    )
                    db.add(
                        models.Notification(
                            user_id=driver_id,
                            kind="delivery",
                            title="Nueva entrega asignada",
                            message=f"V9 te asignó automáticamente el pedido #{order.id}.",
                        )
                    )
                    assigned += 1
                    published.append((order.id, driver_id, "auto-dispatch"))
                else:
                    exists = db.scalar(
                        select(models.OperationalIncident.id).where(
                            models.OperationalIncident.order_id == order.id,
                            models.OperationalIncident.incident_type == "no_driver",
                            models.OperationalIncident.status == "open",
                        )
                    )
                    if not exists:
                        db.add(
                            models.OperationalIncident(
                                order_id=order.id,
                                incident_type="no_driver",
                                severity="high",
                                title="Pedido sin repartidor",
                                detail=f"Pedido #{order.id} sin candidato después de {int(age)} min",
                                recommended_action="Activar incentivo o ampliar disponibilidad",
                            )
                        )
            elif order.status == "assigned" and order.driver_id and age >= 25:
                old = order.driver_id
                candidates = _dispatch_candidates(order, db)
                driver_id = _claim_available_driver(db, candidates, exclude=old)
                if driver_id:
                    order.driver_id = driver_id
                    db.add(
                        models.OrderEvent(
                            order_id=order.id,
                            status="assigned",
                            actor_user_id=None,
                            metadata_json=f'{{"source":"v9_worker_reassign","previous_driver":{old}}}',
                        )
                    )
                    db.add(
                        models.OperationalIncident(
                            order_id=order.id,
                            incident_type="auto_reassignment",
                            severity="medium",
                            title="Entrega reasignada por inactividad",
                            detail=f"Driver {old} sin avance durante {int(age)} min",
                            recommended_action="Monitorear nuevo pickup",
                            status="resolved",
                            resolved_at=instant,
                        )
                    )
                    reassigned += 1
                    published.append((order.id, driver_id, "reassign"))

        online = db.scalar(
            select(models.DriverProfile.id)
            .where(models.DriverProfile.is_online.is_(True), models.DriverProfile.is_verified.is_(True))
            .limit(1)
        )
        waiting = db.scalar(
            select(models.Order.id)
            .where(models.Order.status == "ready", models.Order.driver_id.is_(None))
            .limit(1)
        )
        current = db.scalar(
            select(models.DriverIncentive.id)
            .where(
                models.DriverIncentive.active.is_(True),
                models.DriverIncentive.starts_at <= instant,
                models.DriverIncentive.ends_at >= instant,
            )
            .limit(1)
        )
        if waiting and not online and not current:
            db.add(
                models.DriverIncentive(
                    zone_name="General",
                    title="Alta demanda · incentivo automático",
                    bonus_per_delivery=Decimal("20.00"),
                    multiplier=Decimal("1.10"),
                    starts_at=instant,
                    ends_at=instant + timedelta(hours=2),
                    active=True,
                )
            )
            incentives = 1
        db.commit()

    for order_id, driver_id, source in published:
        publish_order_event(order_id, "order.assigned", {"driver_id": driver_id, "source": f"v9-worker-{source}"})
    return assigned, reassigned, incentives


def _bulk_customer_profiles(db, user_ids: list[int], instant: datetime) -> dict[int, dict]:
    profiles: dict[int, dict] = {
        uid: {"segment": "new", "orders": 0, "lifetime_value": "0.00", "days_since_last_order": None}
        for uid in user_ids
    }
    if not user_ids:
        return profiles
    rows = db.execute(
        select(
            models.Order.user_id,
            func.count(models.Order.id).filter(models.Order.status == "delivered"),
            func.coalesce(func.sum(models.Order.total).filter(models.Order.status == "delivered"), 0),
            func.max(models.Order.created_at),
        )
        .where(models.Order.user_id.in_(user_ids))
        .group_by(models.Order.user_id)
    ).all()
    for user_id, delivered_count, spend_raw, last in rows:
        delivered_count = int(delivered_count or 0)
        spend = Decimal(spend_raw or 0)
        if last and last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        days = (instant - last).days if last else 9999
        if delivered_count == 0:
            segment = "new"
        elif delivered_count >= 20 or spend >= Decimal("8000"):
            segment = "vip"
        elif days >= 30:
            segment = "inactive"
        elif days >= 14:
            segment = "at_risk"
        elif delivered_count >= 5:
            segment = "frequent"
        else:
            segment = "active"
        profiles[int(user_id)] = {
            "segment": segment,
            "orders": delivered_count,
            "lifetime_value": str(spend.quantize(Decimal("0.01"))),
            "days_since_last_order": None if last is None else days,
        }
    return profiles


def run_v9_marketing_automations() -> int:
    """Run active daily CRM automations using aggregate queries instead of order-history N+1."""
    instant = datetime.now(timezone.utc)
    sent = 0
    with SessionLocal() as db:
        from .routes.v9 import now as v9_now

        automations = db.scalars(select(models.MarketingAutomation).where(models.MarketingAutomation.active.is_(True))).all()
        users = db.scalars(
            select(models.User).where(
                models.User.role == "customer",
                models.User.is_active.is_(True),
                models.User.marketing_opt_in.is_(True),
            )
        ).all()
        profiles: dict[int, dict] = {}
        for start in range(0, len(users), settings.worker_batch_size):
            chunk = users[start : start + settings.worker_batch_size]
            profiles.update(_bulk_customer_profiles(db, [user.id for user in chunk], instant))

        recent_events = db.execute(
            select(models.ProductEvent.user_id, models.ProductEvent.event_name, func.max(models.ProductEvent.created_at))
            .where(
                models.ProductEvent.user_id.is_not(None),
                models.ProductEvent.event_name.in_(("add_to_cart", "checkout_completed")),
                models.ProductEvent.created_at >= instant - timedelta(hours=24),
            )
            .group_by(models.ProductEvent.user_id, models.ProductEvent.event_name)
        ).all()
        event_times: dict[int, dict[str, datetime]] = defaultdict(dict)
        for user_id, event_name, event_time in recent_events:
            if user_id is not None and event_time is not None:
                event_times[int(user_id)][str(event_name)] = event_time

        for automation in automations:
            marker = f"v9.marketing.auto:{automation.id}:{instant.strftime('%Y-%m-%d')}"
            if db.scalar(select(models.AuditEvent.id).where(models.AuditEvent.action == marker)):
                continue
            automation_sent = 0
            for user in users:
                profile = profiles.get(user.id, {"segment": "new", "orders": 0, "days_since_last_order": None})
                segment = profile["segment"]
                if automation.segment not in {"all", segment}:
                    continue
                trigger = automation.trigger_type
                if trigger == "inactive_7d" and (profile["days_since_last_order"] is None or profile["days_since_last_order"] < 7):
                    continue
                if trigger == "inactive_30d" and (profile["days_since_last_order"] is None or profile["days_since_last_order"] < 30):
                    continue
                if trigger == "vip" and segment != "vip":
                    continue
                if trigger == "at_risk" and segment != "at_risk":
                    continue
                if trigger == "first_order" and profile["orders"] != 1:
                    continue
                if trigger == "birthday" and (not user.birth_date or user.birth_date[5:] != instant.strftime("%m-%d")):
                    continue
                if trigger == "cart_abandoned":
                    added = event_times.get(user.id, {}).get("add_to_cart")
                    completed = event_times.get(user.id, {}).get("checkout_completed")
                    if not added or (completed and completed >= added):
                        continue
                message = automation.message_template.replace("{coupon}", automation.coupon_code)
                if automation.channel == "email":
                    from .email_service import enqueue_email

                    enqueue_email(db, user.email, automation.name, message)
                else:
                    db.add(models.Notification(user_id=user.id, kind="growth", title=automation.name, message=message))
                sent += 1
                automation_sent += 1
            automation.last_run_at = v9_now()
            db.add(
                models.AuditEvent(
                    user_id=None,
                    action=marker,
                    entity_type="marketing_automation",
                    entity_id=str(automation.id),
                    detail=f"sent={automation_sent}",
                )
            )
        db.commit()
    return sent


def automate_v11_driver_offers() -> tuple[int, int]:
    if not settings.driver_offer_mode:
        return 0, 0
    instant = datetime.now(timezone.utc)
    created = expired = 0
    with SessionLocal() as db:
        from .routes.v9 import _dispatch_candidates

        stale = db.scalars(
            select(models.DriverOffer)
            .where(models.DriverOffer.status == "offered", models.DriverOffer.expires_at <= instant)
            .order_by(models.DriverOffer.expires_at)
            .limit(settings.worker_batch_size)
            .with_for_update(skip_locked=True)
        ).all()
        for offer in stale:
            offer.status = "expired"
            expired += 1

        ready = db.scalars(
            select(models.Order)
            .where(models.Order.status == "ready", models.Order.driver_id.is_(None))
            .order_by(models.Order.ready_at, models.Order.created_at)
            .limit(settings.worker_batch_size)
            .with_for_update(skip_locked=True)
        ).all()
        for order in ready:
            active = db.scalar(
                select(models.DriverOffer.id)
                .where(
                    models.DriverOffer.order_id == order.id,
                    models.DriverOffer.status == "offered",
                    models.DriverOffer.expires_at > instant,
                )
                .limit(1)
            )
            if active:
                continue
            round_no = (db.scalar(select(func.max(models.DriverOffer.round_no)).where(models.DriverOffer.order_id == order.id)) or 0) + 1
            candidates = [c for c in _dispatch_candidates(order, db) if c.get("active_deliveries", 0) == 0][:3]
            for candidate in candidates:
                row = models.DriverOffer(
                    order_id=order.id,
                    driver_id=candidate["driver_id"],
                    round_no=round_no,
                    score=float(candidate.get("score", 0)),
                    estimated_pickup_min=max(3, int(round(float(candidate.get("distance_km", 2)) * 3 + 4))),
                    estimated_earning=order.driver_earning,
                    expires_at=instant + timedelta(seconds=settings.order_offer_seconds),
                )
                db.add(row)
                db.add(
                    models.Notification(
                        user_id=row.driver_id,
                        kind="delivery",
                        title="Oferta de entrega",
                        message=f"Pedido #{order.id} disponible durante {settings.order_offer_seconds}s.",
                    )
                )
                created += 1
            if not candidates:
                exists = db.scalar(
                    select(models.OperationalIncident.id).where(
                        models.OperationalIncident.order_id == order.id,
                        models.OperationalIncident.incident_type == "no_driver",
                        models.OperationalIncident.status == "open",
                    )
                )
                if not exists:
                    db.add(
                        models.OperationalIncident(
                            order_id=order.id,
                            incident_type="no_driver",
                            severity="high",
                            title="Pedido sin candidatos",
                            detail=f"V11 no encontró driver para pedido #{order.id}",
                            recommended_action="Activar incentivo o ampliar cobertura",
                        )
                    )
        db.commit()
    return created, expired


def expire_v11_substitutions() -> int:
    instant = datetime.now(timezone.utc)
    count = 0
    with SessionLocal() as db:
        rows = db.scalars(
            select(models.SubstitutionRequest)
            .where(
                models.SubstitutionRequest.status == "pending",
                models.SubstitutionRequest.expires_at.is_not(None),
                models.SubstitutionRequest.expires_at <= instant,
            )
            .order_by(models.SubstitutionRequest.expires_at)
            .limit(settings.worker_batch_size)
            .with_for_update(skip_locked=True)
        ).all()
        if not rows:
            return 0
        order_ids = {row.order_id for row in rows}
        orders = {o.id: o for o in db.scalars(select(models.Order).where(models.Order.id.in_(order_ids))).all()}
        open_incidents = {
            int(order_id)
            for order_id in db.scalars(
                select(models.OperationalIncident.order_id).where(
                    models.OperationalIncident.order_id.in_(order_ids),
                    models.OperationalIncident.incident_type == "substitution_timeout",
                    models.OperationalIncident.status == "open",
                )
            ).all()
        }
        for row in rows:
            row.status = "expired"
            row.resolution = "customer_timeout"
            row.resolved_at = instant
            count += 1
            order = orders.get(row.order_id)
            if order:
                db.add(
                    models.Notification(
                        user_id=order.user_id,
                        kind="order",
                        title="Cambio de producto expirado",
                        message=f"La solicitud de cambio del pedido #{order.id} expiró. El restaurante la revisará contigo.",
                    )
                )
                if order.id not in open_incidents:
                    db.add(
                        models.OperationalIncident(
                            order_id=order.id,
                            incident_type="substitution_timeout",
                            severity="medium",
                            title="Sustitución sin respuesta",
                            detail=f"Solicitud #{row.id} expiró",
                            recommended_action="Contactar cliente o retirar artículo",
                        )
                    )
                    open_incidents.add(order.id)
        db.commit()
    return count


def deliver_v11_push_notifications() -> tuple[int, int]:
    """Fan out a bounded batch of recent notifications without DB N+1 queries."""
    if not (settings.web_push_vapid_public_key and settings.web_push_vapid_private_key):
        return 0, 0
    sent = failed = 0
    cutoff = datetime.now(timezone.utc) - timedelta(hours=2)
    with SessionLocal() as db:
        notifications = db.scalars(
            select(models.Notification)
            .where(models.Notification.created_at >= cutoff)
            .order_by(models.Notification.created_at.asc())
            .limit(settings.worker_batch_size)
        ).all()
        if not notifications:
            return 0, 0
        user_ids = {n.user_id for n in notifications}
        subscriptions = db.scalars(
            select(models.PushSubscription).where(
                models.PushSubscription.user_id.in_(user_ids),
                models.PushSubscription.active.is_(True),
            )
        ).all()
        by_user: dict[int, list[models.PushSubscription]] = defaultdict(list)
        for sub in subscriptions:
            by_user[sub.user_id].append(sub)
        # A Web Push subscription authorizes operational delivery only.  It is
        # NOT permission for advertising.  Keep the same marketing consent
        # boundary as native FCM even for older PWA/browser subscriptions.
        marketing_allowed = set(db.scalars(
            select(models.User.id).where(
                models.User.id.in_(user_ids),
                models.User.role == "customer",
                models.User.is_active.is_(True),
                models.User.marketing_opt_in.is_(True),
            )
        ).all())
        markers = [
            f"v11.push:{notification.id}:{sub.id}"
            for notification in notifications
            for sub in by_user.get(notification.user_id, [])
        ]
        existing = set()
        for start in range(0, len(markers), 1000):
            chunk = markers[start : start + 1000]
            if chunk:
                existing.update(db.scalars(select(models.AuditEvent.action).where(models.AuditEvent.action.in_(chunk))).all())
        for notification in notifications:
            for sub in by_user.get(notification.user_id, []):
                marker = f"v11.push:{notification.id}:{sub.id}"
                if marker in existing:
                    continue
                if notification.kind in PROMOTIONAL_KINDS and notification.user_id not in marketing_allowed:
                    # Record this decision so opting in tomorrow cannot replay
                    # promotional notifications created without consent today.
                    db.add(models.AuditEvent(
                        user_id=notification.user_id,
                        action=marker,
                        entity_type="push_subscription",
                        entity_id=str(sub.id),
                        detail="suppressed:no_marketing_consent",
                    ))
                    existing.add(marker)
                    continue
                result = send_web_push(
                    {"endpoint": sub.endpoint, "keys": {"p256dh": sub.p256dh, "auth": sub.auth}},
                    notification.title,
                    notification.message,
                    url="/notificaciones",
                )
                if result.ok or result.status == "gone":
                    db.add(models.AuditEvent(
                        user_id=notification.user_id,
                        action=marker,
                        entity_type="push_subscription",
                        entity_id=str(sub.id),
                        detail=f"status={result.status}; {result.detail}"[:1000],
                    ))
                if result.ok:
                    sent += 1
                else:
                    failed += 1
                    if result.status == "gone":
                        sub.active = False
        db.commit()
    return sent, failed


def run_once(lock_token: str | None = None) -> None:
    write_heartbeat()
    with SessionLocal() as db:
        outbox_published, outbox_retried, outbox_dead = process_outbox(db)
    expired = expire_unpaid_orders()
    _refresh_cycle_lock(lock_token)
    removed = cleanup_orphan_proofs()
    scheduled = notify_scheduled_orders()
    _refresh_cycle_lock(lock_token)
    assigned, reassigned, incentives = automate_v9_operations()
    offer_created, offer_expired = automate_v11_driver_offers()
    _refresh_cycle_lock(lock_token)
    substitutions_expired = expire_v11_substitutions()
    marketing = run_v9_marketing_automations()
    _refresh_cycle_lock(lock_token)
    push_sent, push_failed = deliver_v11_push_notifications()
    native_push_sent, native_push_failed = deliver_native_push()
    with SessionLocal() as db:
        emails_sent, emails_failed = send_pending_emails(db, limit=min(settings.worker_batch_size, 100))
    reconciliation_checked = reconciliation_repaired = reconciliation_mismatched = 0
    if _scheduled_due("payment-reconciliation", settings.reconciliation_interval_seconds):
        with SessionLocal() as db:
            if feature_enabled(db, "payments.reconciliation", role="admin", default=True):
                reconciliation_checked, reconciliation_repaired, reconciliation_mismatched = reconcile_mercadopago(
                    db, limit=min(settings.worker_batch_size, 200)
                )
    alert_counts = {}
    if _scheduled_due("system-alerts", max(60, settings.worker_interval_seconds * 2)):
        with SessionLocal() as db:
            alert_counts = evaluate_system_alerts(db)
    retention_counts = {}
    if _scheduled_due("resilience-retention", 86400):
        with SessionLocal() as db:
            retention_counts = cleanup_resilience_history(db, limit=min(5000, settings.worker_batch_size * 10))
    # Drain events produced by this same cycle so apps converge quickly even if an
    # immediate Redis publish failed in an endpoint.
    with SessionLocal() as db:
        p2, r2, d2 = process_outbox(db)
    outbox_published += p2; outbox_retried += r2; outbox_dead += d2
    if any(
        (
            expired,
            removed,
            scheduled,
            assigned,
            reassigned,
            incentives,
            offer_created,
            offer_expired,
            substitutions_expired,
            marketing,
            push_sent,
            push_failed,
            emails_sent,
            emails_failed,
            outbox_published,
            outbox_retried,
            outbox_dead,
            reconciliation_repaired,
            reconciliation_mismatched,
        )
    ):
        log.info(
            "maintenance expired=%s proofs=%s scheduled=%s auto_assign=%s reassign=%s incentives=%s "
            "offers_created=%s offers_expired=%s substitutions_expired=%s marketing=%s push_sent=%s "
            "push_failed=%s email_sent=%s email_failed=%s outbox_published=%s outbox_retry=%s outbox_dead=%s "
            "reconcile_checked=%s reconcile_repaired=%s reconcile_mismatch=%s alerts=%s retention=%s",
            expired,
            removed,
            scheduled,
            assigned,
            reassigned,
            incentives,
            offer_created,
            offer_expired,
            substitutions_expired,
            marketing,
            push_sent,
            push_failed,
            emails_sent,
            emails_failed,
            outbox_published,
            outbox_retried,
            outbox_dead,
            reconciliation_checked,
            reconciliation_repaired,
            reconciliation_mismatched,
            alert_counts,
            retention_counts,
        )


def main() -> None:
    settings.validate_production()
    settings.media_dir.mkdir(parents=True, exist_ok=True)
    log.info("Tala Eats worker started interval=%ss batch=%s", settings.worker_interval_seconds, settings.worker_batch_size)
    while True:
        token = _acquire_cycle_lock()
        if token:
            try:
                run_once(token)
            except Exception:
                log.exception("worker cycle failed")
            finally:
                _release_cycle_lock(token)
        time.sleep(settings.worker_interval_seconds)


if __name__ == "__main__":
    main()
