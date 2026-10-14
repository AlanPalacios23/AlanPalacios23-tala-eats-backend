"""Native Android/iOS notifications via Firebase FCM HTTP v1.

FCM handles APNs forwarding for iOS after Firebase/Apple configuration.
No credentials/tokens ever appear in logs or API responses. Disable by default.
"""
from __future__ import annotations

import hashlib
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import NamedTuple

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import and_, event, func, insert, literal, or_, select
from sqlalchemy.orm import Session

from . import models
from .config import settings
from .db import SessionLocal, get_db
from .deps import get_current_user

log = logging.getLogger("talaeats.native_push")
router = APIRouter(prefix="/api/v1/mobile-push", tags=["mobile-push"])
APP_ROLES = {"customer": "customer", "restaurant": "restaurant", "driver": "driver"}
PROMOTIONAL_KINDS = {"growth", "marketing", "promotion", "sponsored", "promo"}
ORDER_RE = re.compile(r"(?:pedido|orden)\s*#(\d+)", re.IGNORECASE)


def _now():
    return datetime.now(timezone.utc)


def is_configured() -> bool:
    return bool(settings.native_push_enabled and re.fullmatch(r"[a-z0-9][a-z0-9-]{3,80}", settings.fcm_project_id)
                and settings.fcm_credentials_file and settings.fcm_token_encryption_key)


def _cipher():
    from cryptography.fernet import Fernet
    try:
        return Fernet(settings.fcm_token_encryption_key.encode("ascii"))
    except (ValueError, TypeError) as exc:
        raise RuntimeError("FCM_TOKEN_ENCRYPTION_KEY invalida") from exc


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _order_notification(notification: models.Notification) -> bool:
    """Use structured kind as well as legacy order text to enforce a short TTL."""
    return (notification.kind in {"order", "restaurant_order", "driver_order", "delivery", "driver_offer"}
            or bool(ORDER_RE.search(notification.message or "")))


class DeviceRegistration(BaseModel):
    token: str = Field(min_length=20, max_length=4096)
    device_id: str = Field(min_length=8, max_length=96, pattern=r"^[a-zA-Z0-9_.-]+$")
    application: str = Field(pattern=r"^(customer|restaurant|driver)$")
    platform: str = Field(pattern=r"^(android|ios)$")
    marketing_opt_in: bool = False


class PushPreferences(BaseModel):
    marketing_opt_in: bool = False


def _authorize_app(application: str, user: models.User) -> None:
    if APP_ROLES.get(application) != user.role:
        raise HTTPException(403, "Aplicacion no autorizada para esta cuenta")


@router.get("/config")
def push_config():
    return {"enabled": is_configured(), "provider": "fcm", "platforms": ["android", "ios"]}


@router.put("/devices")
def register_device(payload: DeviceRegistration, user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    _authorize_app(payload.application, user)
    if not is_configured():
        raise HTTPException(503, "Push nativo no configurado")
    if not user.is_active:
        raise HTTPException(403, "Cuenta inactiva")
    digest = _token_hash(payload.token)
    # Tokens can rotate; revoke old device mappings within the same transaction.
    existing_token = db.scalar(select(models.MobilePushDevice).where(models.MobilePushDevice.token_hash == digest).with_for_update())
    target = db.scalar(select(models.MobilePushDevice).where(
        models.MobilePushDevice.user_id == user.id,
        models.MobilePushDevice.application == payload.application,
        models.MobilePushDevice.device_id == payload.device_id,
    ).with_for_update())
    if existing_token is not None and existing_token is not target:
        # Enforce one owner per FCM token; do not allow a second account to receive another's notifications.
        existing_token.active = False
        existing_token.token_hash = _token_hash("retired:%s:%s" % (existing_token.id, digest))
    if target is None:
        target = models.MobilePushDevice(user_id=user.id, device_id=payload.device_id, application=payload.application,
                                         platform=payload.platform, token_hash=digest, encrypted_token="")
        db.add(target)
    target.token_hash = digest
    target.encrypted_token = _cipher().encrypt(payload.token.encode("utf-8")).decode("ascii")
    target.platform = payload.platform
    target.active = True
    target.marketing_push_enabled = payload.marketing_opt_in if payload.application == "customer" else False
    db.commit()
    return {"registered": True, "application": target.application, "marketing_opt_in": target.marketing_push_enabled}


@router.delete("/devices/{device_id}")
def unregister_device(device_id: str, user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    device = db.scalar(select(models.MobilePushDevice).where(models.MobilePushDevice.user_id == user.id,
                        models.MobilePushDevice.device_id == device_id).with_for_update())
    if device is not None:
        device.active = False
        db.commit()
    return {"registered": False}


@router.put("/devices/{device_id}/preferences")
def update_preferences(device_id: str, payload: PushPreferences, user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    device = db.scalar(select(models.MobilePushDevice).where(models.MobilePushDevice.user_id == user.id,
                       models.MobilePushDevice.device_id == device_id, models.MobilePushDevice.active.is_(True)))
    if device is None:
        raise HTTPException(404, "Dispositivo no encontrado")
    if user.role != "customer" and payload.marketing_opt_in:
        raise HTTPException(403, "Promociones solo para clientes")
    device.marketing_push_enabled = payload.marketing_opt_in
    db.commit()
    return {"marketing_opt_in": device.marketing_push_enabled}


@event.listens_for(models.Notification, "after_insert")
def enqueue_for_new_notification(mapper, connection, target):
    """Create one durable delivery per registered device IN SAME DB transaction.

    No external provider calls inside the transaction. When native push is off,
    no extra writes occur and existing order flow is untouched.
    """
    if not is_configured():
        return
    dev = models.MobilePushDevice.__table__
    jobs = models.MobilePushDelivery.__table__
    connection.execute(insert(jobs).from_select(
        ["notification_id", "device_id", "state", "attempts", "next_attempt_at", "last_error", "created_at"],
        select(literal(target.id), dev.c.id, literal("queued"), literal(0), literal(_now()), literal(""), literal(_now())).where(
            dev.c.user_id == target.user_id, dev.c.active.is_(True),
        ),
    ))


class SendResult(NamedTuple):
    ok: bool
    permanent: bool = False
    reason: str = ""


def _send_fcm(token: str, *, title: str, body: str, notification_id: int, order_id: str = "") -> SendResult:
    """Send via FCM HTTP v1, using server credentials, never client SDK keys."""
    import requests
    from google.auth.transport.requests import Request as GoogleRequest
    from google.oauth2 import service_account
    creds = service_account.Credentials.from_service_account_file(
        settings.fcm_credentials_file, scopes=["https://www.googleapis.com/auth/firebase.messaging"])
    creds.refresh(GoogleRequest())
    data = {"notification_id": str(notification_id), "kind": "order" if order_id else "inbox", "order_id": order_id}
    payload = {"message": {"token": token,
        "notification": {"title": title[:150], "body": body[:480]},
        "data": data,
        "android": {"priority": "high" if order_id else "normal", "ttl": "21600s" if order_id else "86400s",
                    "notification": {"channel_id": "orders" if order_id else "promotions"}},
        "apns": {"headers": {"apns-priority": "10" if order_id else "5",
                            "apns-expiration": str(int(_now().timestamp()) + (21600 if order_id else 86400))},
                 "payload": {"aps": {"sound": "default" if order_id else "", "thread-id": "order" if order_id else "promotion"}}},
    }}
    try:
        response = requests.post(
            f"https://fcm.googleapis.com/v1/projects/{settings.fcm_project_id}/messages:send",
            json=payload, headers={"Authorization": f"Bearer {creds.token}"}, timeout=settings.native_push_http_timeout)
        if response.ok:
            return SendResult(True)
        # UNREGISTERED and INVALID_ARGUMENT for valid FCM request => expired/bad device token.
        text = response.text[:1200]
        expired = "UNREGISTERED" in text or "registration-token-not-registered" in text
        return SendResult(False, permanent=expired, reason=f"http_{response.status_code}")
    except requests.RequestException:
        return SendResult(False, reason="provider_unavailable")


def deliver_native_push() -> tuple[int, int]:
    if not is_configured():
        return 0, 0
    sent = failed = 0
    instant = _now()
    # Claim in a short transaction before network I/O; stale claims are recoverable.
    with SessionLocal() as db:
        jobs = db.scalars(select(models.MobilePushDelivery).where(or_(
            and_(models.MobilePushDelivery.state == "queued", models.MobilePushDelivery.next_attempt_at <= instant),
            and_(models.MobilePushDelivery.state == "processing", models.MobilePushDelivery.claimed_until <= instant),
        )).order_by(models.MobilePushDelivery.id).limit(settings.native_push_batch_size).with_for_update(skip_locked=True)).all()
        ids = [job.id for job in jobs]
        for job in jobs:
            job.state = "processing"
            job.claimed_until = instant + timedelta(seconds=max(90, settings.native_push_http_timeout * 3))
        db.commit()
    for job_id in ids:
        with SessionLocal() as db:
            job = db.get(models.MobilePushDelivery, job_id)
            if job is None:
                continue
            device = db.get(models.MobilePushDevice, job.device_id)
            notification = db.get(models.Notification, job.notification_id)
            user = db.get(models.User, device.user_id) if device else None
            if not device or not notification or not user or not device.active or not user.is_active or device.user_id != notification.user_id:
                job.state = "suppressed"; db.commit(); continue
            promo = notification.kind in PROMOTIONAL_KINDS
            if APP_ROLES.get(device.application) != user.role:
                job.state = "suppressed"; db.commit(); continue
            if promo and (not device.marketing_push_enabled or not user.marketing_opt_in or user.role != "customer"):
                job.state = "suppressed"; db.commit(); continue
            # Limit promotional pushes to two per device over any rolling 24h period.
            if promo:
                recent_promos = db.scalar(select(func.count(models.MobilePushDelivery.id))
                    .join(models.Notification, models.Notification.id == models.MobilePushDelivery.notification_id)
                    .where(models.MobilePushDelivery.device_id == device.id,
                           models.MobilePushDelivery.state == "sent",
                           models.MobilePushDelivery.delivered_at >= _now() - timedelta(hours=24),
                           models.Notification.kind.in_(tuple(PROMOTIONAL_KINDS)))) or 0
                if recent_promos >= 2:
                    job.state = "suppressed"; db.commit(); continue
            # An offline phone must not receive yesterday's pickup request or
            # sale notification.  Keep provider TTL and queue expiry aligned.
            max_age = timedelta(hours=6 if _order_notification(notification) else 24)
            if (_now() - notification.created_at.replace(tzinfo=notification.created_at.tzinfo or timezone.utc)) > max_age:
                job.state = "expired"; db.commit(); continue
            try:
                token = _cipher().decrypt(device.encrypted_token.encode("ascii")).decode("utf-8")
                found = ORDER_RE.search(notification.message)
                order_id = found.group(1) if found else ""
                result = _send_fcm(token, title=notification.title, body=notification.message, notification_id=notification.id, order_id=order_id)
            except Exception:
                log.exception("FCM provider error for delivery id %s", job_id)
                result = SendResult(False, reason="provider_exception")
            job.attempts += 1
            job.last_error = result.reason[:240]
            job.claimed_until = None
            if result.ok:
                job.state = "sent"; job.delivered_at = _now(); sent += 1
            elif result.permanent:
                job.state = "dead"; device.active = False; failed += 1
            elif job.attempts >= settings.native_push_max_attempts:
                job.state = "dead"; failed += 1
            else:
                job.state = "queued"
                job.next_attempt_at = _now() + timedelta(seconds=min(3600, 15 * 2 ** min(job.attempts, 8)))
                failed += 1
            db.commit()
    return sent, failed
