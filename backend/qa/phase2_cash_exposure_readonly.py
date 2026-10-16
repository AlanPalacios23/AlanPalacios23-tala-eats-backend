"""F2.10: non-mutating cash collector exposure and hypothetical netting check.

Does not create an API, bank instruction, payout, ledger row, settlement or
active dispatch restriction. Inputs are UNTRUSTED snapshots. No status in
this module grants settlement, transfer, payout or authorization to net.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
import os


@dataclass(frozen=True)
class CashPreview:
    decision: str
    collector_id: int
    recorded_receipts_mxn: Decimal
    hypothetical_same_payee_offset_mxn: Decimal
    gross_exposure_mxn: Decimal
    hold_future_cash_offers_recommended: bool
    findings: tuple[str, ...]
    payout_authorized: bool = False
    execute_netting: bool = False


def amount(value) -> Decimal:
    try:
        if type(value) not in (str, int, Decimal):
            raise ValueError("untrusted money type")
        result = Decimal(str(value))
        if not result.is_finite() or result.as_tuple().exponent < -2 or result < 0:
            raise ValueError("untrusted amount")
        return result
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise ValueError("F210 invalid MXN amount") from exc


def preview_cash(
    *,
    collector_id: int,
    orders: list[dict],
    digital_credits: list[dict],
    exposure_limit_mxn,
) -> CashPreview:
    """Return only an accounting hypothesis, requiring external verification.

    Digital credits count as *hypothetical* only when independently matched
    to the exact collector and a provider status of 'settled'. A string status
    is NOT trusted bank evidence. Unknown/duplicate orders fail closed.
    """
    if type(collector_id) is not int or collector_id <= 0:
        raise ValueError("collector required")
    limit = amount(exposure_limit_mxn)
    if limit <= 0 or not isinstance(orders, list) or not isinstance(digital_credits, list):
        raise ValueError("invalid limit or input")
    errors = set()
    seen_orders = set()
    seen_credit_ids = set()
    receipts = Decimal("0")
    potential_credit = Decimal("0")
    for order in orders:
        if not isinstance(order, dict):
            errors.add("INVALID_ORDER")
            continue
        try:
            oid = order["order_id"]
            if type(oid) is not int or oid <= 0 or oid in seen_orders:
                errors.add("DUPLICATE_OR_INVALID_ORDER_ID")
                continue
            seen_orders.add(oid)
            if order["payment_method"] != "cash" or order["order_type"] != "delivery":
                continue  # Pickup or card is never a driver cash collection.
            if order["status"] != "delivered":
                errors.add("ACTIVE_OR_UNFINISHED_DELIVERY_EXCLUDED")
                continue
            driver = order["driver_id"]
            collector = order["collector_id"]
            if type(driver) is not int or driver != collector_id or collector != collector_id:
                errors.add("COLLECTOR_IDENTITY_NOT_PROVEN")
                continue
            expected = amount(order["total"])
            collected = amount(order["cash_collected"])
            if expected <= 0 or expected != collected:
                errors.add("CASH_COLLECTION_NOT_RECONCILED")
                continue
            receipts += collected
        except (KeyError, ValueError, TypeError):
            errors.add("INVALID_ORDER")

    for credit in digital_credits:
        if not isinstance(credit, dict):
            errors.add("INVALID_DIGITAL_CREDIT")
            continue
        try:
            cid = credit["external_credit_ref"]
            if not isinstance(cid, str) or not cid or cid in seen_credit_ids:
                errors.add("DUPLICATE_OR_INVALID_CREDIT_REF")
                continue
            seen_credit_ids.add(cid)
            payee = credit["beneficiary_id"]
            if type(payee) is not int or payee != collector_id:
                errors.add("CROSS_BENEFICIARY_NETTING_FORBIDDEN")
                continue
            if credit["provider_status"] != "settled":
                errors.add("UNCONFIRMED_PSP_CREDIT_EXCLUDED")
                continue
            potential_credit += amount(credit["amount_mxn"])
        except (KeyError, ValueError, TypeError):
            errors.add("INVALID_DIGITAL_CREDIT")

    gross = receipts
    # Display-only candidate, not an approved/verified deduction.
    offset = min(receipts, potential_credit) if not errors else Decimal("0")
    if errors:
        decision = "NO_GO_DATA_INTEGRITY"
    else:
        decision = "PENDING_CUSTODY_PSP_LEGAL_APPROVAL"
        errors.add("BANK_AND_CASH_CUSTODY_NOT_INDEPENDENTLY_VERIFIED")
        errors.add("COLLECTOR_CONSENT_NOT_VERIFIED")
    return CashPreview(
        decision=decision, collector_id=collector_id,
        recorded_receipts_mxn=receipts,
        hypothetical_same_payee_offset_mxn=offset,
        gross_exposure_mxn=gross,
        hold_future_cash_offers_recommended=(bool(errors & {
            "CASH_COLLECTION_NOT_RECONCILED", "COLLECTOR_IDENTITY_NOT_PROVEN",
            "DUPLICATE_OR_INVALID_ORDER_ID", "CROSS_BENEFICIARY_NETTING_FORBIDDEN",
        }) or gross > limit),
        findings=tuple(sorted(errors)),
    )


def assert_disposable():
    from app.config import settings
    expected = "postgresql+psycopg://talaqa:qa-only-local@127.0.0.1:5432/talaqa"
    if not (os.getenv("GITHUB_ACTIONS") == "true"
            and os.getenv("DATABASE_URL") == expected == settings.database_url
            and os.getenv("REDIS_URL") == "redis://127.0.0.1:6379/0"
            and settings.environment == "development"
            and not settings.seed_demo_data
            and not settings.stripe_enabled
            and not settings.stripe_connect_enabled
            and not settings.withdrawals_preview_enabled
            and not settings.withdrawals_execution_enabled
            and not settings.withdrawals_live_enabled
            and not settings.stripe_secret_key
            and not settings.stripe_connect_webhook_secret
            and not settings.mercado_pago_access_token):
        raise RuntimeError("F210 only disposable QA accepted")


def main():
    assert_disposable()
    from app import models
    from app.db import SessionLocal
    from sqlalchemy import select, text
    with SessionLocal() as db:
        db.execute(text("SET TRANSACTION READ ONLY"))
        orders = db.scalars(select(models.Order).where(
            models.Order.client_reference.like("F211-PG-%")
        ).order_by(models.Order.id)).all()
        assert len(orders) == 3
        cash_deliveries = [x for x in orders
                           if x.payment_method == "cash" and x.order_type == "delivery"]
        pickups = [x for x in orders
                   if x.payment_method == "cash" and x.order_type == "pickup"]
        assert len(cash_deliveries) == len(pickups) == 1
        assert all(o.status != "delivered" for o in cash_deliveries)
        synthetic = [{
            "order_id": o.id, "payment_method": o.payment_method,
            "order_type": o.order_type, "status": o.status,
            "driver_id": o.driver_id, "collector_id": o.driver_id,
            "total": o.total, "cash_collected": o.cash_collected,
        } for o in orders]
    # QA receipts are never treated as verified: not even assigned/collected.
    result = preview_cash(collector_id=10001, orders=synthetic, digital_credits=[],
                          exposure_limit_mxn="100.00")
    assert result.recorded_receipts_mxn == 0
    assert result.hypothetical_same_payee_offset_mxn == 0
    assert result.payout_authorized is False and result.execute_netting is False
    assert "ACTIVE_OR_UNFINISHED_DELIVERY_EXCLUDED" in result.findings
    print("F210_PG_CASH_PREVIEW_FAIL_CLOSED_PASS: cash order not delivered "
          "cannot become receivable, cash pickup excluded, no cross-owner netting; "
          "no write, no payout, no real money")


if __name__ == "__main__":
    main()
