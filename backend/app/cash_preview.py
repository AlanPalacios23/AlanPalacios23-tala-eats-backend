"""Conservative, read-only cash projections for a future bank-reconciled system.

NO transfer, no settlement creation, no cash debt enforcement. Order snapshots
record an app event, NOT proof of physical cash collection or SPEI receipt.
The collector rules are provisional until contracts / pilot policy are approved.
"""
from __future__ import annotations

from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any

CENT = Decimal("0.01")
ZERO = Decimal("0.00")
TOLERANCE = CENT


def _amount(value: Any) -> Decimal:
    try:
        number = Decimal(str(value if value is not None else "0"))
    except (ValueError, TypeError, InvalidOperation) as exc:
        raise ValueError("invalid_cash_amount") from exc
    if not number.is_finite() or number < ZERO:
        raise ValueError("invalid_cash_amount")
    if number.quantize(CENT, rounding=ROUND_HALF_UP) != number:
        raise ValueError("cash_amount_more_than_two_decimals")
    return number.quantize(CENT)


def _money(number: Decimal) -> str:
    return str(number.quantize(CENT))


def _zero_view(order: Any, *, reason: str) -> dict[str, Any]:
    return {
        "order_id": int(getattr(order, "id", 0)),
        "collector_type": None,
        "collector_id": None,
        "status": "requires_review",
        "reason": reason,
        "cash_recorded": "0.00",
        "collector_entitlement": "0.00",
        "remittance_projection": "0.00",
        "merchant_receivable": "0.00",
        "platform_revenue_estimate": "0.00",
        "bank_verified": False,
        "actionable": False,
    }


def project_cash_order(order: Any) -> dict[str, Any]:
    """Project a *single* delivered cash order; never book a receivable here.

    The full customer payment belongs to the collector only temporarily.
    Remittance != Tala Eats revenue: it may include restaurant liabilities.
    """
    if getattr(order, "payment_method", "") != "cash":
        return _zero_view(order, reason="not_cash")
    if getattr(order, "status", "") != "delivered":
        return _zero_view(order, reason="not_delivered")
    if getattr(order, "payment_status", "") != "paid":
        return _zero_view(order, reason="not_recorded_paid")
    if getattr(order, "refunded_amount", None) is not None:
        try:
            if _amount(order.refunded_amount) > ZERO:
                return _zero_view(order, reason="refund_requires_reconciliation")
        except ValueError:
            return _zero_view(order, reason="invalid_amount")
    if getattr(order, "order_type", "") not in {"delivery", "pickup"}:
        return _zero_view(order, reason="unsupported_order_type")
    if getattr(order, "order_type", "") == "delivery":
        if not getattr(order, "driver_id", None):
            return _zero_view(order, reason="no_driver_to_confirm_collection")
        collector_type = "driver"
        collector_id = int(order.driver_id)
    else:
        if not getattr(order, "restaurant_id", None):
            return _zero_view(order, reason="no_restaurant_to_confirm_collection")
        collector_type = "restaurant"
        collector_id = int(order.restaurant_id)
    try:
        total = _amount(getattr(order, "total", None))
        recorded = _amount(getattr(order, "cash_collected", None))
        merchant = _amount(getattr(order, "restaurant_payout", None))
        driver = _amount(getattr(order, "driver_earning", None))
        tip = _amount(getattr(order, "tip", None))
        revenue = Decimal(str(getattr(order, "platform_revenue", "0") or "0"))
        if not revenue.is_finite():
            raise ValueError("nonfinite")
        revenue = revenue.quantize(CENT)
        if total <= ZERO or recorded != total:
            return _zero_view(order, reason="cash_receipt_missing_or_inconsistent")
        if abs(total - (merchant + driver + tip + revenue)) > TOLERANCE:
            return _zero_view(order, reason="economics_do_not_balance")
        if collector_type == "restaurant":
            if driver != ZERO:
                return _zero_view(order, reason="pickup_with_driver_earning")
            retained = merchant
        else:
            retained = driver + tip
        due = recorded - retained
        if due < ZERO:
            return _zero_view(order, reason="collector_entitlement_exceeds_cash")
        return {
            "order_id": int(order.id),
            "collector_type": collector_type,
            "collector_id": collector_id,
            "status": "projected_unverified",
            "reason": "cash_recorded_by_app_not_bank_verified",
            "cash_recorded": _money(recorded),
            "collector_entitlement": _money(retained),
            "remittance_projection": _money(due),
            "merchant_receivable": _money(merchant) if collector_type == "driver" else "0.00",
            "platform_revenue_estimate": _money(revenue),
            "bank_verified": False,
            "actionable": False,
        }
    except (ValueError, InvalidOperation, TypeError):
        return _zero_view(order, reason="invalid_amount")


def summarize_cash_projection(
    rows: list[dict[str, Any]],
    *,
    has_more: bool = False,
    legacy_hold_collectors: set[tuple[str, int]] | None = None,
) -> dict[str, Any]:
    """Aggregate a *page* of projections; ignore all blocked/unsafe values."""
    holds = legacy_hold_collectors or set()
    output: list[dict[str, Any]] = []
    page_total = ZERO
    held_count = 0
    eligible_count = 0
    for row in rows:
        result = dict(row)
        key = (result["collector_type"], result["collector_id"])
        if result["status"] == "projected_unverified" and key in holds:
            result["status"] = "historical_hold"
            result["reason"] = "legacy_cash_or_payout_history_requires_manual_reconciliation"
            result["actionable"] = False
            held_count += 1
        elif result["status"] == "projected_unverified":
            page_total += Decimal(result["remittance_projection"])
            eligible_count += 1
        output.append(result)
    return {
        "preview_only": True,
        "bank_verified": False,
        "may_collect": False,
        "complete": not has_more,
        "has_more": has_more,
        "records_on_page": len(output),
        "projected_records_on_page": eligible_count,
        "historical_hold_records_on_page": held_count,
        "projected_unverified_remittance_on_page": _money(page_total),
        "warning": (
            "Vista orientativa sin validez de cobro: no prueba recepción de efectivo ni SPEI, "
            "no descuenta liquidaciones históricas automáticamente. "
            "El total de esta página no es saldo exigible ni fondos de Tala Eats."
        ),
        "orders": output,
    }
