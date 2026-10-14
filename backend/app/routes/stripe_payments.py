"""Isolated Stripe checkout, signed webhooks, refunds and guarded settlement.

Integration is opt-in. Existing Mercado Pago and other payment routes are unchanged.
"""
from __future__ import annotations
import json
import logging
from datetime import datetime, timezone
from decimal import Decimal
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from .. import models
from ..config import settings
from ..db import get_db
from ..deps import get_current_user, require_role
from ..inventory import restore_order_inventory
from ..monetization import post_refund_ledger
from ..outbox import enqueue_event
from ..stripe_gateway import (stripe_client, intent_create, intent_retrieve, refund_create,
                               transfer_create, parse_webhook, data_dict, money_cents)

log = logging.getLogger("talaeats.stripe")
router = APIRouter(prefix="/api/v1/payments/stripe", tags=["stripe-payments"])


def get_order_locked(db: Session, oid: int):
    return db.scalar(select(models.Order).where(models.Order.id == oid).with_for_update())


def _event(db, order: models.Order, kind: str, evkey: str, data: dict):
    enqueue_event(db, event_key=evkey, aggregate_type="order", aggregate_id=order.id,
                  event_type=kind, payload={"order_id": order.id, "status": order.status,
                                            "payment_status": order.payment_status, **data})


def _cancel_unpaid(db, order, reason: str):
    if order.status not in {"cancelled", "delivered"}:
        restore_order_inventory(db, order)
        order.status = "cancelled"
        order.cancelled_reason = reason[:300]
        db.add(models.OrderEvent(order_id=order.id, status="cancelled", actor_user_id=order.user_id,
                                 metadata_json=json.dumps({"source": "stripe", "reason": reason[:100]})))


@router.get("/config")
def config():
    enabled = bool(settings.stripe_enabled and settings.stripe_secret_key and settings.stripe_webhook_secret)
    return {"enabled": enabled,
            "publishable_key": settings.stripe_publishable_key if enabled else None,
            "currency": "mxn", "merchant_country": "MX", "connect_enabled": enabled and settings.stripe_connect_enabled,
            "apple_merchant_id": settings.stripe_apple_merchant_id if enabled else None}


@router.post("/orders/{order_id}/payment-intent")
def make_payment_intent(order_id: int, user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    client = stripe_client()
    order = db.get(models.Order, order_id)
    if not order or (user.role != "admin" and order.user_id != user.id):
        raise HTTPException(404, "Pedido no encontrado")
    if order.payment_method != "stripe":
        raise HTTPException(409, "Este pedido no usa Stripe")
    if order.status == "cancelled" or order.payment_status in {"expired", "refunded", "disputed"}:
        raise HTTPException(409, "Pedido no disponible para pago")
    if order.payment_status == "paid":
        return {"order_id": order.id, "already_paid": True, "payment_status": "paid"}
    if money_cents(order.total) < 1000:
        raise HTTPException(409, "El pedido es inferior al mínimo permitido para este método")
    if order.payment_provider_id and not order.payment_provider_id.startswith("pi_"):
        raise HTTPException(409, "Identificador de pago incompatible")
    # Short transactions. API call uses deterministic provider-level idempotency.
    try:
        pi = (intent_retrieve(client, order.payment_provider_id) if order.payment_provider_id else
              intent_create(client, order, f"tala:stripe:intent:v1:order:{order.id}"))
    except Exception as exc:
        log.warning("Stripe intent unavailable: %s", type(exc).__name__)
        raise HTTPException(502, "No se pudo iniciar el pago con Stripe") from exc
    data = data_dict(pi)
    if (data.get("metadata") or {}).get("tala_order_id") != str(order.id) or data.get("currency") != "mxn" or int(data.get("amount", -1)) != money_cents(order.total):
        raise HTTPException(409, "Discrepancia entre Stripe y el pedido")
    if data.get("status") in {"canceled", "succeeded"}:
        # Confirmations MUST come from verified webhook; never trust a client.
        if data.get("status") == "succeeded":
            return {"order_id": order.id, "payment_status": "pending_confirmation"}
        raise HTTPException(409, "El intento de pago ya no es reutilizable")
    order = get_order_locked(db, order.id)
    if not order or order.payment_status != "pending" or order.status == "cancelled":
        db.rollback()
        raise HTTPException(409, "El pedido cambió durante la creación del pago")
    if order.payment_provider_id and order.payment_provider_id != data["id"]:
        db.rollback()
        raise HTTPException(409, "Intento de pago distinto en la base de datos")
    order.payment_provider_id = data["id"]
    order.payment_preference_id = data["id"]
    order.payment_provider = "stripe"
    db.commit()
    return {"order_id": order.id, "payment_intent_id": data["id"],
            "client_secret": data.get("client_secret"),
            "publishable_key": settings.stripe_publishable_key,
            "amount_cents": money_cents(order.total), "currency": "mxn",
            "payment_status": "pending"}


@router.post("/webhook")
async def webhook(request: Request, db: Session = Depends(get_db)):
    payload = await request.body()
    if len(payload) > 1024 * 1024:
        raise HTTPException(413, "Evento Stripe demasiado grande")
    event = data_dict(parse_webhook(payload, request.headers.get("stripe-signature", "")))
    event_id = str(event.get("id", ""))
    typ = str(event.get("type", ""))
    obj = data_dict((event.get("data") or {}).get("object") or {})
    if not event_id.startswith("evt_") or len(event_id) > 220:
        raise HTTPException(400, "ID de evento inválido")
    # A test event must not mutate live-mode orders or vice versa.
    if bool(event.get("livemode")) != settings.stripe_secret_key.startswith(("sk_live_", "rk_live_")):
        raise HTTPException(400, "Modo Stripe incompatible")
    db.add(models.PaymentEvent(provider="stripe", provider_event_id=event_id, event_type=typ[:80],
                               payload=payload.decode("utf-8", errors="replace")[:8000]))
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        return {"received": True, "duplicate": True}
    handled = False
    if typ in {"payment_intent.succeeded", "payment_intent.payment_failed", "payment_intent.canceled"}:
        metadata = obj.get("metadata") or {}
        order_id = str(metadata.get("tala_order_id", ""))
        order = get_order_locked(db, int(order_id)) if order_id.isdigit() else None
        if order and order.payment_method == "stripe":
            if (obj.get("currency") != "mxn" or int(obj.get("amount", -1)) != money_cents(order.total)
                or (typ == "payment_intent.succeeded" and obj.get("amount_received") is not None
                    and int(obj["amount_received"]) != money_cents(order.total))):
                raise HTTPException(409, "Monto o moneda del pago no coincide con el pedido")
            if order.payment_provider_id and order.payment_provider_id != obj.get("id"):
                raise HTTPException(409, "Intento de pago no corresponde al pedido")
            if not order.payment_provider_id:
                order.payment_provider_id = str(obj["id"])
                order.payment_preference_id = str(obj["id"])
            if typ == "payment_intent.succeeded":
                if order.status == "cancelled" or order.payment_status in {"expired", "refunded"}:
                    # Do not convert an expired/cancelled order into a deliverable one.
                    # The webhook is retried on refund failure.
                    client = stripe_client()
                    refund = await run_in_threadpool(refund_create, client, obj["id"], money_cents(order.total), f"tala:stripe:late-refund:v1:{order.id}")
                    refund = data_dict(refund)
                    if refund.get("status") not in {"succeeded", "pending"}:
                        raise HTTPException(502, "Stripe aún no pudo confirmar el reembolso tardío")
                    order.payment_status = "refunded" if refund["status"] == "succeeded" else "refund_pending"
                    order.refunded_amount = Decimal(order.total) if refund["status"] == "succeeded" else Decimal("0")
                    if refund["status"] == "succeeded":
                        post_refund_ledger(db, order, Decimal(order.total), idempotency_suffix="stripe-late")
                elif order.payment_status not in {"paid", "partially_refunded", "refunded", "refund_pending", "disputed"}:
                    order.payment_status = "paid"
                    owner_id = db.scalar(select(models.Restaurant.owner_id).where(models.Restaurant.id == order.restaurant_id))
                    if owner_id:
                        db.add(models.Notification(user_id=owner_id, kind="restaurant_order", title="Nuevo pedido pagado",
                                                   message=f"Pedido #{order.id} confirmado y listo para preparar."))
                    db.add(models.Notification(user_id=order.user_id, kind="payment", title="Pago confirmado",
                                               message=f"Stripe confirmó el pago del pedido #{order.id}."))
            elif typ == "payment_intent.canceled" and order.payment_status == "pending":
                order.payment_status = "failed"
                _cancel_unpaid(db, order, "Stripe canceló el intento de pago")
            # payment_intent.payment_failed can be retried on the SAME PaymentIntent.
            # Keep pending and notify; reservation expiry releases stock later.
            elif typ == "payment_intent.payment_failed" and order.payment_status == "pending":
                db.add(models.Notification(user_id=order.user_id, kind="payment", title="Pago no aprobado",
                                           message=f"Puedes reintentar el pago del pedido #{order.id}."))
            _event(db, order, "payment.stripe_updated", f"stripe:event:{event_id}:order:{order.id}", {"provider_event": typ})
            handled = True
    elif typ == "charge.refunded":
        pi = obj.get("payment_intent")
        if isinstance(pi, str) and pi.startswith("pi_"):
            order = db.scalar(select(models.Order).where(models.Order.payment_provider_id == pi, models.Order.payment_method == "stripe").with_for_update())
            if order:
                total_cents = money_cents(order.total)
                refunded_cents = int(obj.get("amount_refunded", 0))
                if refunded_cents < 0 or refunded_cents > total_cents:
                    raise HTTPException(409, "Monto de reembolso inconsistente")
                previous = money_cents(order.refunded_amount or 0)
                if refunded_cents > previous:
                    delta = Decimal(refunded_cents - previous) / Decimal(100)
                    post_refund_ledger(db, order, delta, idempotency_suffix=f"stripe-event-{event_id}")
                    order.refunded_amount = Decimal(refunded_cents) / Decimal(100)
                if refunded_cents == total_cents:
                    order.payment_status = "refunded"
                    if order.status not in {"cancelled", "delivered"}:
                        _cancel_unpaid(db, order, "Stripe confirmó reembolso completo")
                elif refunded_cents > 0:
                    order.payment_status = "partially_refunded"
                _event(db, order, "payment.stripe_refund_synced", f"stripe:event:{event_id}:order:{order.id}", {})
                handled = True
    elif typ == "charge.dispute.created":
        pi = obj.get("payment_intent")
        if isinstance(pi, str) and pi.startswith("pi_"):
            order = db.scalar(select(models.Order).where(models.Order.payment_provider_id == pi, models.Order.payment_method == "stripe").with_for_update())
            if order:
                order.payment_status = "disputed"
                db.add(models.Notification(user_id=order.user_id, kind="payment", title="Pago en disputa",
                                           message=f"El pago del pedido #{order.id} requiere revisión."))
                _event(db, order, "payment.disputed", f"stripe:event:{event_id}:order:{order.id}", {})
                handled = True
    # Unknown events are acknowledged after signature validation and durable receipt.
    db.commit()
    return {"received": True, "handled": handled}


@router.post("/admin/orders/{order_id}/refund")
def refund(order_id: int, _: models.User = Depends(require_role("admin")), db: Session = Depends(get_db)):
    client = stripe_client()
    # Serialize the external refund with settlement.  A previously-created
    # transfer in ANY state may already exist at Stripe even if our DB still
    # says pending/retry after a network timeout.  Fail closed until a human
    # has reconciled/reversed it rather than refunding AND paying the merchant.
    order = get_order_locked(db, order_id)
    if not order or order.payment_method != "stripe" or not order.payment_provider_id:
        raise HTTPException(404, "No existe pago Stripe para este pedido")
    if order.payment_status == "refunded":
        return {"order_id": order.id, "already_refunded": True}
    if order.payment_status != "paid":
        raise HTTPException(409, "Stripe no ha confirmado un pago reembolsable")
    if db.scalar(select(models.StripeTransfer.id).where(models.StripeTransfer.order_id == order.id)):
        raise HTTPException(409, "Existe una liquidación iniciada; requiere conciliación y reversión antes del reembolso")
    try:
        resp = data_dict(refund_create(client, order.payment_provider_id, money_cents(order.total), f"tala:stripe:refund:v1:{order.id}"))
    except Exception as exc:
        log.warning("Stripe refund unavailable: %s", type(exc).__name__)
        raise HTTPException(502, "Stripe no pudo procesar el reembolso") from exc
    if resp.get("status") not in {"succeeded", "pending"}:
        raise HTTPException(502, "Stripe no confirmó el reembolso")
    order = get_order_locked(db, order_id)
    if order.payment_status == "refunded":
        db.rollback()
        return {"order_id": order.id, "already_refunded": True}
    if order.payment_status != "paid":
        raise HTTPException(409, "Estado del pago cambió durante el reembolso")
    if resp.get("status") == "succeeded":
        order.payment_status = "refunded"
        order.refunded_amount = Decimal(order.total)
        if order.status not in {"cancelled", "delivered"}:
            _cancel_unpaid(db, order, "Reembolso Stripe por ADMIN")
        post_refund_ledger(db, order, Decimal(order.total), idempotency_suffix="stripe-admin")
    else:
        order.payment_status = "refund_pending"
    _event(db, order, "payment.stripe_refund", f"stripe:refund:admin:{order.id}", {"refund_status": resp["status"]})
    db.commit()
    return {"order_id": order.id, "payment_status": order.payment_status,
            "stripe_refund_id": resp.get("id")}


@router.get("/admin/orders/{order_id}/settlement-preview")
def preview(order_id: int, _: models.User = Depends(require_role("admin")), db: Session = Depends(get_db)):
    order = db.get(models.Order, order_id)
    if not order or order.payment_method != "stripe":
        raise HTTPException(404, "Pedido Stripe no encontrado")
    # Driver receives base earning AND customer tip; restaurant payout is separate.
    restaurant_cents = money_cents(order.restaurant_payout)
    driver_cents = money_cents(Decimal(order.driver_earning or 0) + (Decimal(order.tip or 0) if order.order_type == "delivery" and not settings.merchant_managed_delivery else Decimal("0")))
    expected_remainder = money_cents(order.total) - restaurant_cents - driver_cents
    return {"order_id": order.id, "eligible": order.status == "delivered" and order.payment_status == "paid",
            "restaurant_cents": restaurant_cents, "driver_cents": driver_cents,
            "platform_remainder_before_stripe_fees_cents": expected_remainder,
            "stripe_connect_enabled": bool(settings.stripe_enabled and settings.stripe_connect_enabled),
            "transfers": [{"recipient_type": row.recipient_type, "status": row.status, "transfer_id": row.transfer_id}
                          for row in db.scalars(select(models.StripeTransfer).where(models.StripeTransfer.order_id == order_id))]}


class RecipientLink(BaseModel):
    account_id: str = Field(pattern=r"^acct_[A-Za-z0-9]{8,80}$")


@router.put("/admin/recipients/{role}/{entity_id}")
def recipient_link(role: str, entity_id: int, payload: RecipientLink,
                   _: models.User = Depends(require_role("admin")), db: Session = Depends(get_db)):
    if not (settings.stripe_enabled and settings.stripe_connect_enabled):
        raise HTTPException(503, "Stripe Connect está inactivo")
    client = stripe_client()
    try:
        account = data_dict(client.v2.core.accounts.retrieve(payload.account_id))
        capabilities = ((account.get("configuration") or {}).get("recipient") or {}).get("capabilities") or {}
        transfers = ((capabilities.get("stripe_balance") or {}).get("stripe_transfers") or {})
        if transfers.get("status") != "active":
            raise HTTPException(409, "La cuenta Stripe no tiene transferencias activas")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, "No se pudo verificar la cuenta conectada en Stripe") from exc
    if role == "restaurant":
        entity = db.get(models.Restaurant, entity_id)
    elif role == "driver":
        entity = db.scalar(select(models.DriverProfile).where(models.DriverProfile.user_id == entity_id))
    else:
        raise HTTPException(400, "Rol de beneficiario inválido")
    if entity is None:
        raise HTTPException(404, "Beneficiario inexistente")
    entity.payout_account_ref = payload.account_id
    db.commit()
    return {"recipient": role, "id": entity_id, "connected": True, "account_id": payload.account_id}


@router.post("/admin/orders/{order_id}/settle")
def settle(order_id: int, _: models.User = Depends(require_role("admin")), db: Session = Depends(get_db)):
    if not (settings.stripe_enabled and settings.stripe_connect_enabled):
        raise HTTPException(503, "Stripe Connect no está habilitado")
    # Explicit administrative action, NEVER triggered merely by a checkout or a
    # client-side success. Delivery completed and provider funds confirmed first.
    order = get_order_locked(db, order_id)
    if not order or order.payment_method != "stripe":
        raise HTTPException(404, "Pedido Stripe no encontrado")
    if order.payment_status != "paid" or order.status != "delivered":
        raise HTTPException(409, "Solo se liquidan pedidos entregados y pagados")
    restaurant = db.get(models.Restaurant, order.restaurant_id)
    profile = db.scalar(select(models.DriverProfile).where(models.DriverProfile.user_id == order.driver_id)) if order.driver_id else None
    restaurant_cents = money_cents(order.restaurant_payout)
    driver_cents = money_cents(Decimal(order.driver_earning or 0) + (Decimal(order.tip or 0) if order.order_type == "delivery" and not settings.merchant_managed_delivery else Decimal("0")))
    if restaurant_cents + driver_cents > money_cents(order.total):
        raise HTTPException(409, "La distribución supera el total del cobro")
    recipients = [("restaurant", restaurant_cents, (restaurant.payout_account_ref if restaurant else "")),
                  ("driver", driver_cents, (profile.payout_account_ref if profile else ""))]
    if any(amount > 0 and (not acct or not acct.startswith("acct_")) for _, amount, acct in recipients):
        raise HTTPException(409, "Faltan cuentas Connect verificadas de los beneficiarios")
    existing = {x.recipient_type: x for x in db.scalars(select(models.StripeTransfer).where(models.StripeTransfer.order_id == order.id)).all()}
    for role, amount, account in recipients:
        if amount > 0 and role not in existing:
            row = models.StripeTransfer(order_id=order.id, recipient_type=role,
                                        connected_account_id=account, amount_cents=amount, status="pending")
            db.add(row)
    db.commit()
    client = stripe_client()
    try:
        pi = data_dict(intent_retrieve(client, order.payment_provider_id))
    except Exception as exc:
        raise HTTPException(502, "No se pudo verificar el pago original en Stripe") from exc
    if pi.get("status") != "succeeded" or money_cents(order.total) != int(pi.get("amount_received", -1)):
        raise HTTPException(409, "El pago Stripe no está confirmado por el proveedor")
    charge_id = pi.get("latest_charge")
    if not isinstance(charge_id, str) or not charge_id.startswith("ch_"):
        raise HTTPException(409, "No se encontró el cargo para transferencias")
    out = []
    for role, amount, account in recipients:
        if not amount:
            continue
        current_order = get_order_locked(db, order_id)
        if (not current_order or current_order.payment_status != "paid"
                or current_order.status != "delivered" or current_order.payment_method != "stripe"):
            db.rollback()
            raise HTTPException(409, "El pedido ya no está habilitado para liquidación")
        row = db.scalar(select(models.StripeTransfer).where(models.StripeTransfer.order_id == order_id,
                                                             models.StripeTransfer.recipient_type == role).with_for_update())
        if row.status == "completed":
            out.append({"recipient": role, "transfer_id": row.transfer_id, "duplicate": True})
            db.rollback()
            continue
        if row.amount_cents != amount or row.connected_account_id != account:
            db.rollback()
            raise HTTPException(409, "Datos del beneficiario cambiaron durante la liquidación")
        # Keep the order/transfer lock until the provider result is persisted.
        # The admin refund path takes the same order lock, preventing an
        # interleaved refund/settlement that pays out already-refunded money.
        try:
            transfer = data_dict(transfer_create(client, charge_id, account, amount, order_id, role))
            if not str(transfer.get("id", "")).startswith("tr_"):
                raise RuntimeError("Transfer Stripe sin ID")
        except Exception as exc:
            log.warning("Stripe transfer %s failed: %s", role, type(exc).__name__)
            row = db.scalar(select(models.StripeTransfer).where(models.StripeTransfer.order_id == order_id,
                                                                 models.StripeTransfer.recipient_type == role).with_for_update())
            row.status = "retry"
            row.last_error = type(exc).__name__[:500]
            db.commit()
            raise HTTPException(502, "Stripe no pudo completar todas las transferencias; reintenta con idempotencia") from exc
        row = db.scalar(select(models.StripeTransfer).where(models.StripeTransfer.order_id == order_id,
                                                             models.StripeTransfer.recipient_type == role).with_for_update())
        row.transfer_id = transfer["id"]
        row.status = "completed"
        row.last_error = ""
        row.completed_at = datetime.now(timezone.utc)
        db.commit()
        out.append({"recipient": role, "transfer_id": row.transfer_id, "amount_cents": amount})
    return {"order_id": order_id, "transfers": out}
