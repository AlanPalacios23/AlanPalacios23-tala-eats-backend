"""F2.09 regression: pending/local-paid does not mean bank custody or payout."""
from copy import deepcopy

import pytest

from qa.phase2_reconciliation_readonly import audit_order, mxn


def example(payment="mercadopago"):
    order = {
        "total": "500.00",
        "restaurant_payout": "350.00",
        "driver_earning": "100.00",
        "tip": "20.00",
        "platform_revenue": "30.00",
        "order_type": "delivery",
        "payment_method": payment,
        "payment_status": "pending",
    }
    parts = {
        "gmv": "500.00",
        "restaurant_payable": "350.00",
        "driver_payable": "120.00",
        "platform_revenue": "30.00",
    }
    ledger = [
        {
            "account": account,
            "direction": "credit",
            "amount": amount,
            "currency": "MXN",
            "kind": "order_settlement",
            "idempotency_key": "order:123:ledger:" + account,
        }
        for account, amount in parts.items()
    ]
    return order, ledger


@pytest.mark.parametrize("method", ["cash", "mercadopago", "stripe"])
def test_balance_never_means_money_available(method):
    order, ledger = example(method)
    expected = "CASH_COLLECTOR_AND_CUSTODY_NOT_VERIFIED" if method == "cash" \
        else "PSP_BANK_SETTLEMENT_NOT_VERIFIED"
    result = audit_order(order, ledger)
    assert result.status == "PENDING_EXTERNAL_EVIDENCE"
    assert expected in result.findings
    assert result.payout_authorized is False


def test_local_paid_is_not_verified_bank_settlement():
    order, ledger = example("stripe")
    order["payment_status"] = "paid"
    result = audit_order(order, ledger)
    assert result.status == "PENDING_EXTERNAL_EVIDENCE"
    assert result.payout_authorized is False


def test_delivery_tips_entirely_in_driver_payable():
    order, ledger = example()
    ledger[2]["amount"] = "100.00"  # lost 20 MXN tip
    result = audit_order(order, ledger)
    assert result.status == "NO_GO_LEDGER"
    assert "LEDGER_AMOUNT_MISMATCH_DRIVER_PAYABLE" in result.findings


def test_cash_pickup_no_driver_tip_goes_to_restaurant():
    order, ledger = example("cash")
    order.update({"order_type": "pickup", "driver_earning": "0.00",
                  "restaurant_payout": "470.00"})
    ledger = [row for row in ledger if row["account"] != "driver_payable"]
    ledger[1]["amount"] = "470.00"
    result = audit_order(order, ledger)
    assert result.status == "PENDING_EXTERNAL_EVIDENCE"
    assert result.payout_authorized is False


@pytest.mark.parametrize("tamper,code", [
    ("duplicate_key", "DUPLICATE_OR_MISSING_IDEMPOTENCY_KEY"),
    ("duplicate_account", "DUPLICATE_LEDGER_ACCOUNT"),
    ("currency", "WRONG_LEDGER_CURRENCY"),
    ("refund", "REFUND_REQUIRES_INDEPENDENT_RECONCILIATION"),
    ("direction", "WRONG_LEDGER_DIRECTION_OR_KIND"),
    ("negative", "NONPOSITIVE_LEDGER_AMOUNT"),
    ("wrong_total", "LEDGER_AMOUNT_MISMATCH_GMV"),
])
def test_tampered_ledger_blocks_reconciliation(tamper, code):
    order, ledger = example()
    if tamper == "duplicate_key":
        ledger[1]["idempotency_key"] = ledger[0]["idempotency_key"]
    elif tamper == "duplicate_account":
        ledger.append({**ledger[0], "idempotency_key": "qa-extra-key"})
    elif tamper == "currency":
        ledger[0]["currency"] = "USD"
    elif tamper == "refund":
        ledger.append({**ledger[0], "kind": "refund",
                       "idempotency_key": "qa-refund"})
    elif tamper == "direction":
        ledger[0]["direction"] = "debit"
    elif tamper == "negative":
        ledger[0]["amount"] = "-500.00"
    elif tamper == "wrong_total":
        ledger[0]["amount"] = "499.99"
    result = audit_order(order, ledger)
    assert result.status == "NO_GO_LEDGER"
    assert code in result.findings
    assert result.payout_authorized is False


def test_order_unbalanced_even_when_gmv_matches():
    order, ledger = example()
    order["platform_revenue"] = "31.00"
    result = audit_order(order, ledger)
    assert result.status == "NO_GO_LEDGER"
    assert "ORDER_COMPONENTS_UNBALANCED" in result.findings


def test_missing_ledger_and_malformed_amounts_fail_closed():
    order, ledger = example()
    assert audit_order(order, []).status == "NO_GO_LEDGER"
    order["total"] = "NaN"
    assert audit_order(order, ledger).status == "NO_GO_LEDGER"
    with pytest.raises(ValueError):
        mxn(True)
    with pytest.raises(ValueError):
        mxn("1.234")


def test_audit_does_not_mutate_inputs():
    order, ledger = example()
    saved = deepcopy((order, ledger))
    assert audit_order(order, ledger) == audit_order(order, ledger)
    assert (order, ledger) == saved
