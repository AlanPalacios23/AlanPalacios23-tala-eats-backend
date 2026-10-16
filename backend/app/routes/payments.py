from datetime import datetime, timedelta, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from starlette.concurrency import run_in_threadpool

from .. import models
from ..config import settings
from ..db import get_db
from ..deps import get_current_user, require_role
from ..http_client import get as http_get, post as http_post
from ..inventory import restore_order_inventory
from ..monetization import post_refund_ledger
from ..realtime import publish_order_event

router = APIRouter(prefix="/api/v1/payments", tags=["payments"])


def _mp_headers() -> dict[str, str]:
    if not settings.mercado_pago_access_token:
        raise HTTPException(503, "Mercado Pago no está configurado en este servidor")
    return {"Authorization": f"Bearer {settings.mercado_pago_access_token}", "Content-Type": "application/json"}


def _refund_headers(order_id: int) -> dict[str, str]:
    headers = _mp_headers().copy()
    headers["X-Idempotency-Key"] = f"talaeats-refund-order-{order_id}"
    return headers


@router.get("/config")
def payment_config():
    return {
        "provider": settings.payment_provider,
        "mercadopago_enabled": bool(settings.mercado_pago_access_token),
        "public_key": settings.mercado_pago_public_key or None,
        "reservation_minutes": settings.payment_reservation_minutes,
        "marketplace_fee_enabled": settings.mercado_pago_marketplace_fee_enabled,
        "stripe_enabled": bool(settings.stripe_enabled and settings.stripe_secret_key and settings.stripe_webhook_secret),
        "stripe_publishable_key": settings.stripe_publishable_key if settings.stripe_enabled else None,
        "stripe_connect_enabled": bool(settings.stripe_enabled and settings.stripe_connect_enabled),
        "stripe_apple_merchant_id": settings.stripe_apple_merchant_id or None,
    }


@router.post("/mercadopago/orders/{order_id}/checkout")
def create_checkout(order_id: int, user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if settings.payment_provider != "mercadopago":
        raise HTTPException(503, "Mercado Pago no es el proveedor activo")
    order = db.get(models.Order, order_id)
    if not order or (user.role != "admin" and order.user_id != user.id):
        raise HTTPException(404, "Pedido no encontrado")
    if order.status == "cancelled":
        raise HTTPException(409, "Este pedido ya fue cancelado")
    if order.payment_status == "paid":
        return {"already_paid": True, "order_id": order.id}
    if order.payment_method != "mercadopago":
        raise HTTPException(400, "Este pedido no usa Mercado Pago")

    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(minutes=settings.payment_reservation_minutes)
    payload = {
        "items": [{"title": f"Pedido Tala Eats #{order.id}", "quantity": 1, "currency_id": "MXN", "unit_price": float(order.total)}],
        "expires": True,
        "expiration_date_from": now.isoformat(timespec="milliseconds"),
        "expiration_date_to": expires_at.isoformat(timespec="milliseconds"),
        "external_reference": str(order.id),
        "back_urls": {
            "success": f"{settings.frontend_url}/pedido/{order.id}?payment=success",
            "pending": f"{settings.frontend_url}/pedido/{order.id}?payment=pending",
            "failure": f"{settings.frontend_url}/pedido/{order.id}?payment=failure",
        },
        "auto_return": "approved",
        "notification_url": f"{settings.public_base_url}/api/v1/payments/mercadopago/webhook",
        "metadata": {"talaeats_order_id": order.id, "customer_id": order.user_id},
    }
    if settings.mercado_pago_marketplace_fee_enabled:
        payload["marketplace_fee"] = float(Decimal(order.platform_commission or 0) + Decimal(order.service_fee or 0))
    headers = _mp_headers().copy()
    headers["X-Idempotency-Key"] = f"talaeats-checkout-order-{order.id}"
    response = http_post("https://api.mercadopago.com/checkout/preferences", headers=headers, json=payload, timeout=12)
    if response.status_code >= 400:
        raise HTTPException(502, "Mercado Pago rechazó la creación del checkout")
    data = response.json()
    order.payment_provider = "mercadopago"
    order.payment_preference_id = data.get("id", "")
    db.commit()
    return {"order_id": order.id, "preference_id": data.get("id"), "checkout_url": data.get("init_point"), "sandbox_url": data.get("sandbox_init_point"), "expires_at": expires_at}


def _verify_mp_signature(request: Request, data_id: str) -> None:
    if not settings.mercado_pago_webhook_secret:
        if settings.is_production:
            raise HTTPException(503, "Webhook secret no configurado")
        return
    try:
        from mercadopago.webhook import WebhookSignatureValidator, InvalidWebhookSignatureError  # noqa: F401
        WebhookSignatureValidator.validate(
            request.headers.get("x-signature"),
            request.headers.get("x-request-id"),
            data_id,
            settings.mercado_pago_webhook_secret,
        )
    except Exception as exc:
        raise HTTPException(401, "Firma de webhook inválida") from exc


@router.post("/mercadopago/webhook")
async def mercado_pago_webhook(request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    data_id = str(request.query_params.get("data.id") or (body.get("data") or {}).get("id") or "")
    event_type = str(request.query_params.get("type") or body.get("type") or "")
    if not data_id:
        return {"received": True, "ignored": "missing-data-id"}
    _verify_mp_signature(request, data_id)

    event_key = f"{body.get('id','')}:{body.get('date_created','')}:{event_type}:{data_id}:{body.get('action','')}"
    # Claim the provider event before doing side effects. The unique constraint makes
    # duplicate webhooks safe even when several API workers receive them at once.
    db.add(models.PaymentEvent(provider="mercadopago", provider_event_id=event_key, event_type=event_type, payload=str(body)[:8000]))
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        return {"received": True, "duplicate": True}

    publish_after_commit = None
    if event_type == "payment":
        response = await run_in_threadpool(http_get, f"https://api.mercadopago.com/v1/payments/{data_id}", headers=_mp_headers(), timeout=12)
        if not response.ok:
            raise HTTPException(502, "No se pudo consultar el estado del pago en Mercado Pago")
        payment = response.json()
        external_reference = str(payment.get("external_reference") or "")
        order = db.scalar(select(models.Order).where(models.Order.id == int(external_reference)).with_for_update()) if external_reference.isdigit() else None
        if order:
            amount = Decimal(str(payment.get("transaction_amount") or "0")).quantize(Decimal("0.01"))
            expected = Decimal(order.total).quantize(Decimal("0.01"))
            if amount != expected:
                raise HTTPException(409, "El monto notificado no coincide con el pedido")
            order.payment_provider_id = str(payment.get("id") or data_id)
            status = str(payment.get("status") or "")

            # A previously terminal refund or chargeback cannot be resurrected
            # by a late, duplicated or out-of-order provider notification. The
            # event remains auditable, but no customer/owner notification, stock
            # restoration or ledger credit is generated for this stale state.
            was_terminal = order.payment_status in {"refunded", "charged_back", "disputed"}
            if was_terminal:
                pass
            elif status == "approved":
                # Very-late approvals after the local reservation expired are immediately refunded.
                if order.status == "cancelled" and order.payment_status == "expired":
                    refund_response = await run_in_threadpool(
                        http_post,
                        f"https://api.mercadopago.com/v1/payments/{order.payment_provider_id}/refunds",
                        headers=_refund_headers(order.id),
                        json={},
                        timeout=15,
                    )
                    if not refund_response.ok:
                        raise HTTPException(502, "Pago tardío aprobado; no se pudo reembolsar automáticamente")
                    order.payment_status = "refunded"
                    order.refunded_amount = Decimal(order.total)
                    order.cancelled_reason = "Pago aprobado después de vencer la reserva; reembolso automático"
                    post_refund_ledger(db, order, Decimal(order.total), idempotency_suffix="late-approval")
                else:
                    first_approval = order.payment_status != "paid"
                    order.payment_status = "paid"
                    if first_approval:
                        owner_id = db.scalar(select(models.Restaurant.owner_id).where(models.Restaurant.id == order.restaurant_id))
                        if owner_id:
                            db.add(models.Notification(user_id=owner_id, kind="restaurant_order", title="Nuevo pedido pagado",
                                                       message=f"Pedido #{order.id} confirmado y listo para preparar."))
                    db.add(models.Notification(user_id=order.user_id, kind="payment", title="Pago confirmado", message=f"Mercado Pago confirmó el pedido #{order.id}."))
            elif status in {"rejected", "cancelled", "refunded", "charged_back"}:
                # Inventory may already have been released by an expiry/admin refund.
                # The locked order row makes this check the single source of truth.
                if order.status != "cancelled":
                    restore_order_inventory(db, order)
                order.payment_status = "failed" if status in {"rejected", "cancelled"} else status
                if status == "refunded":
                    order.refunded_amount = Decimal(order.total)
                    post_refund_ledger(db, order, Decimal(order.total), idempotency_suffix="provider-webhook")
                order.status = "cancelled"
                order.cancelled_reason = f"Mercado Pago: {status}"
            else:
                # Pending notifications may arrive after a successful checkout.
                # Never downgrade an already-paid order on stale pending data.
                if order.payment_status != "paid":
                    order.payment_status = "pending"
            if not was_terminal:
                publish_after_commit = (order.id, {"payment_status": order.payment_status, "status": order.status})

    # Persist only after processing succeeds. If Mercado Pago lookup fails, return 5xx so it can retry.
    db.commit()
    if publish_after_commit:
        publish_order_event(publish_after_commit[0], "payment.updated", publish_after_commit[1])
    return {"received": True}


@router.post("/mercadopago/orders/{order_id}/refund")
def refund_order(order_id: int, _: models.User = Depends(require_role("admin")), db: Session = Depends(get_db)):
    # Do not hold a PostgreSQL row lock while waiting on Mercado Pago. The provider
    # call is idempotent and local side effects are serialized after it returns.
    order = db.get(models.Order, order_id)
    if not order:
        raise HTTPException(404, "Pedido no encontrado")
    if order.payment_method != "mercadopago" or not order.payment_provider_id:
        raise HTTPException(409, "El pedido no tiene un pago de Mercado Pago reembolsable")
    if order.payment_status == "refunded":
        return {"order_id": order.id, "payment_status": "refunded", "already_refunded": True}
    if order.payment_status != "paid":
        raise HTTPException(409, "El pedido no tiene un pago aprobado de Mercado Pago para reembolsar")

    response = http_post(
        f"https://api.mercadopago.com/v1/payments/{order.payment_provider_id}/refunds",
        headers=_refund_headers(order.id),
        json={},
        timeout=15,
    )
    if response.status_code >= 400:
        detail = "Mercado Pago rechazó el reembolso"
        try:
            detail = (response.json().get("message") or detail)[:300]
        except (ValueError, TypeError, AttributeError):
            pass
        raise HTTPException(502, detail)

    order = db.scalar(select(models.Order).where(models.Order.id == order_id).with_for_update())
    if not order:
        raise HTTPException(404, "Pedido no encontrado")
    if order.payment_status == "refunded":
        db.rollback()
        return {
            "order_id": order.id,
            "payment_status": "refunded",
            "already_refunded": True,
            "provider_response": response.json(),
        }
    if order.payment_status != "paid":
        current = order.payment_status
        db.rollback()
        raise HTTPException(409, f"El pago cambió de estado durante el reembolso: {current}")

    if order.status != "cancelled":
        restore_order_inventory(db, order)
    order.refunded_amount = Decimal(order.total)
    order.payment_status = "refunded"
    order.status = "cancelled"
    post_refund_ledger(db, order, Decimal(order.total), idempotency_suffix="admin-full")
    order.cancelled_reason = "Reembolso total procesado por ADMIN"
    db.add(
        models.Notification(
            user_id=order.user_id,
            kind="payment",
            title="Reembolso procesado",
            message=f"Se solicitó el reembolso del pedido #{order.id} a Mercado Pago.",
        )
    )
    db.commit()
    publish_order_event(order.id, "payment.refunded", {"payment_status": "refunded", "status": "cancelled"})
    return {"order_id": order.id, "payment_status": order.payment_status, "provider_response": response.json()}
