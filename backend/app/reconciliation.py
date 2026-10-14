from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models
from .config import settings
from .http_client import get as http_get
from .inventory import restore_order_inventory
from .monetization import post_refund_ledger
from .outbox import enqueue_event

log = logging.getLogger("talaeats.reconciliation")


def reconcile_mercadopago(db: Session, *, limit: int = 100) -> tuple[int, int, int]:
    """Compare provider state with Tala Eats and repair only unambiguous mismatches."""
    if settings.payment_provider != "mercadopago" or not settings.mercado_pago_access_token:
        return 0, 0, 0
    cutoff = datetime.now(timezone.utc) - timedelta(hours=settings.reconciliation_lookback_hours)
    rows = db.scalars(
        select(models.Order)
        .where(
            models.Order.payment_method == "mercadopago",
            models.Order.payment_provider_id != "",
            models.Order.updated_at >= cutoff,
        )
        .order_by(models.Order.updated_at.desc())
        .limit(max(1, min(limit, 500)))
    ).all()
    checked = repaired = mismatched = 0
    headers = {"Authorization": f"Bearer {settings.mercado_pago_access_token}"}
    for candidate in rows:
        try:
            response = http_get(f"https://api.mercadopago.com/v1/payments/{candidate.payment_provider_id}", headers=headers, timeout=8)
            if not response.ok:
                continue
            payload = response.json()
            provider = str(payload.get("status") or "")
        except Exception:
            log.exception("payment reconciliation lookup failed order=%s", candidate.id)
            continue
        checked += 1
        local = candidate.payment_status
        action = "none"
        detail = ""
        order = db.scalar(select(models.Order).where(models.Order.id == candidate.id).with_for_update())
        if not order:
            continue
        if provider == "approved" and local in {"pending", "corporate_pending", "failed"} and order.status != "cancelled":
            order.payment_status = "paid"; action = "mark_paid"; repaired += 1
            enqueue_event(db, event_key=f"reconcile:{order.id}:approved:{provider}", aggregate_type="order", aggregate_id=order.id,
                          event_type="payment.reconciled", payload={"order_id": order.id, "payment_status": "paid", "source": "mercadopago"})
        elif provider in {"refunded", "charged_back"} and local != provider:
            if order.status != "cancelled":
                restore_order_inventory(db, order)
            order.payment_status = provider
            order.status = "cancelled"
            if provider == "refunded":
                amount = Decimal(str(payload.get("transaction_amount_refunded") or payload.get("transaction_amount") or order.total))
                order.refunded_amount = max(Decimal(order.refunded_amount or 0), amount)
                post_refund_ledger(db, order, amount, idempotency_suffix=f"reconcile-{provider}")
            action = f"mark_{provider}"; repaired += 1
        elif provider and provider != local and not (provider == "approved" and local == "paid"):
            action = "review"; mismatched += 1
            detail = "Estado no reconciliable automáticamente"
        db.add(models.PaymentReconciliation(provider="mercadopago", order_id=order.id, provider_payment_id=order.payment_provider_id,
                                             local_status=local, provider_status=provider, action=action, detail=detail,
                                             status="repaired" if action.startswith("mark_") else ("mismatch" if action == "review" else "checked")))
        db.commit()
    return checked, repaired, mismatched
