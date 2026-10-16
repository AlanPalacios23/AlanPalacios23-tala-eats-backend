"""F2.09 independent evidence gate for order ledger, QA/read-only only.

The immutable order ledger contains accounting expectations. Neither a balanced
ledger nor a local payment status proves PSP settlement, bank custody or payout
availability. This module intentionally has NO "GO"/"available" outcome.

Integration path: select three synthetic F2.11 orders on disposable PG16.
No backend routes, provider calls, bank operations, writes or LIVE secrets.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
import os


@dataclass(frozen=True)
class ReconciliationResult:
    status: str
    findings: tuple[str, ...]
    payout_authorized: bool = False


def mxn(value) -> Decimal:
    try:
        if value is None or isinstance(value, bool):
            raise ValueError("missing/boolean currency value")
        number = Decimal(str(value))
        if not number.is_finite() or number.as_tuple().exponent < -2:
            raise ValueError("invalid cent precision")
        return number
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError("invalid MXN amount") from exc


def audit_order(order: dict, entries: list[dict]) -> ReconciliationResult:
    """Fail closed on mismatched/duplicated ledger; never infer funds available.

    Inputs are snapshots, not proof fetched from a PSP. Returns NO_GO_LEDGER
    for any mismatch or PENDING_EXTERNAL_EVIDENCE for coherent expectations.
    Both statuses are mandatory payout holds.
    """
    findings: list[str] = []

    def fail(message: str):
        if message not in findings:
            findings.append(message)

    try:
        total = mxn(order["total"])
        restaurant = mxn(order["restaurant_payout"])
        driver = mxn(order["driver_earning"])
        tip = mxn(order["tip"])
        platform = mxn(order["platform_revenue"])
        kind = order["order_type"]
        payment = order["payment_method"]
        if min(total, restaurant, driver, tip, platform) < 0:
            fail("NEGATIVE_ORDER_AMOUNT")
        if kind not in {"delivery", "pickup"}:
            fail("UNKNOWN_ORDER_TYPE")
        if payment not in {"cash", "mercadopago", "stripe"}:
            fail("UNKNOWN_PAYMENT_METHOD")
        delivery_tip = tip if kind == "delivery" and driver > 0 else Decimal(0)
        expected_driver = driver + delivery_tip
        if restaurant + expected_driver + platform != total:
            fail("ORDER_COMPONENTS_UNBALANCED")
        expected = {"gmv": total, "restaurant_payable": restaurant,
                    "driver_payable": expected_driver, "platform_revenue": platform}
    except (ValueError, KeyError, TypeError):
        return ReconciliationResult("NO_GO_LEDGER", ("MALFORMED_ORDER",))

    if not isinstance(entries, list) or not entries:
        return ReconciliationResult("NO_GO_LEDGER", ("MISSING_LEDGER",))
    seen_keys: set[str] = set()
    rows: dict[str, Decimal] = {}
    for line in entries:
        try:
            account = line["account"]
            direction = line["direction"]
            amount = mxn(line["amount"])
            currency = line["currency"]
            movement_type = line["kind"]
            key = line["idempotency_key"]
            if not isinstance(key, str) or not key or key in seen_keys:
                fail("DUPLICATE_OR_MISSING_IDEMPOTENCY_KEY")
            else:
                seen_keys.add(key)
            if amount <= 0:
                fail("NONPOSITIVE_LEDGER_AMOUNT")
            if currency != "MXN":
                fail("WRONG_LEDGER_CURRENCY")
            if movement_type == "refund":
                fail("REFUND_REQUIRES_INDEPENDENT_RECONCILIATION")
            if account in expected:
                if account in rows:
                    fail("DUPLICATE_LEDGER_ACCOUNT")
                rows[account] = amount
                if direction != "credit" or movement_type != "order_settlement":
                    fail("WRONG_LEDGER_DIRECTION_OR_KIND")
        except (TypeError, ValueError, KeyError):
            fail("MALFORMED_LEDGER_LINE")

    for account, amount in expected.items():
        if amount == 0:
            if account in rows:
                fail("UNEXPECTED_ZERO_ACCOUNT_ENTRY")
        elif account not in rows or rows[account] != amount:
            fail("LEDGER_AMOUNT_MISMATCH_" + account.upper())

    if findings:
        return ReconciliationResult("NO_GO_LEDGER", tuple(sorted(findings)))

    # A "paid" local status is NOT evidence of PSP settlement or bank receipt.
    # Cash requires verified physical collector/custody instead.
    if payment == "cash":
        reason = "CASH_COLLECTOR_AND_CUSTODY_NOT_VERIFIED"
    else:
        reason = "PSP_BANK_SETTLEMENT_NOT_VERIFIED"
    return ReconciliationResult(
        "PENDING_EXTERNAL_EVIDENCE", (reason, "BENEFICIARY_FUNDS_NOT_VERIFIED")
    )


def assert_ci_environment():
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
        raise RuntimeError("F209: only the exact disposable GitHub QA fixture is allowed")


def main():
    assert_ci_environment()
    from sqlalchemy import select, text
    from app import models
    from app.db import SessionLocal

    with SessionLocal() as db:
        # PG transaction forcibly READ ONLY; code has no commits/writes.
        db.execute(text("SET TRANSACTION READ ONLY"))
        orders = db.scalars(select(models.Order).where(
            models.Order.client_reference.like("F211-PG-%")
        ).order_by(models.Order.id)).all()
        assert len(orders) == 3, "F209 requires three F211 synthetic checkout orders"
        seen_payment_modes = set()
        for order in orders:
            rows = db.scalars(select(models.FinancialLedgerEntry).where(
                models.FinancialLedgerEntry.order_id == order.id
            )).all()
            snapshot = {key: getattr(order, key) for key in (
                "total", "restaurant_payout", "driver_earning", "tip",
                "platform_revenue", "order_type", "payment_method", "payment_status",
            )}
            ledger = [{key: getattr(row, key) for key in (
                "account", "direction", "amount", "currency", "kind", "idempotency_key"
            )} for row in rows]
            result = audit_order(snapshot, ledger)
            assert order.payment_status == "pending", "Unexpected PSP claim"
            assert result.status == "PENDING_EXTERNAL_EVIDENCE", result
            assert not result.payout_authorized
            assert all(row.currency == "MXN" for row in rows)
            seen_payment_modes.add(order.payment_method)
        assert seen_payment_modes == {"cash", "mercadopago"}
    print("F209_READ_ONLY_PG_LEDGER_EXPECTATIONS_PASS: three synthetic orders, "
          "no bank custody inferred, both PSP and cash payouts held, "
          "no writes/no provider calls/no LIVE")


if __name__ == "__main__":
    main()
