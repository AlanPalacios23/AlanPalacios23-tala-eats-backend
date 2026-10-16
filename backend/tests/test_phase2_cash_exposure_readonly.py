"""F2.10: never settle funds or block active orders from hypothetical cash data."""
from copy import deepcopy
from decimal import Decimal

import pytest

from qa.phase2_cash_exposure_readonly import amount, preview_cash


def delivered(oid=10, *, collector=7, value="500.00"):
    return {
        "order_id": oid, "payment_method": "cash",
        "order_type": "delivery", "status": "delivered",
        "driver_id": collector, "collector_id": collector,
        "total": value, "cash_collected": value,
    }


def credit(ref="psp-test-1", *, beneficiary=7, status="settled", value="120.00"):
    return {
        "external_credit_ref": ref, "beneficiary_id": beneficiary,
        "provider_status": status, "amount_mxn": value,
    }


def preview(orders, credits=(), collector=7, limit="1000.00"):
    return preview_cash(collector_id=collector, orders=list(orders),
                        digital_credits=list(credits), exposure_limit_mxn=limit)


def test_balanced_cash_without_psp_proof_never_enables_payout():
    r = preview([delivered()], [credit()])
    assert r.decision == "PENDING_CUSTODY_PSP_LEGAL_APPROVAL"
    assert r.recorded_receipts_mxn == Decimal("500")
    assert r.gross_exposure_mxn == Decimal("500")
    assert r.hypothetical_same_payee_offset_mxn == Decimal("120")
    assert "BANK_AND_CASH_CUSTODY_NOT_INDEPENDENTLY_VERIFIED" in r.findings
    assert r.payout_authorized is False and r.execute_netting is False


def test_exposure_above_qa_limit_only_recommends_future_hold():
    r = preview([delivered()], limit="100.00")
    assert r.hold_future_cash_offers_recommended is True
    assert r.payout_authorized is False
    assert r.execute_netting is False


@pytest.mark.parametrize("status", ["received", "accepted", "on_the_way", "cancelled"])
def test_unfinished_or_cancelled_order_not_counted_as_cash_collected(status):
    order = delivered()
    order["status"] = status
    r = preview([order])
    assert r.recorded_receipts_mxn == 0
    assert "ACTIVE_OR_UNFINISHED_DELIVERY_EXCLUDED" in r.findings
    assert not r.execute_netting


def test_pickup_and_card_are_not_driver_cash_collections():
    pickup = delivered(11)
    pickup["order_type"] = "pickup"
    card = delivered(12)
    card["payment_method"] = "stripe"
    r = preview([pickup, card])
    assert r.recorded_receipts_mxn == 0
    assert r.decision == "PENDING_CUSTODY_PSP_LEGAL_APPROVAL"


@pytest.mark.parametrize("change", [
    {"driver_id": 8},
    {"collector_id": None},
    {"collector_id": 8},
])
def test_collector_has_to_match_delivery_driver(change):
    order = delivered()
    order.update(change)
    r = preview([order])
    assert r.decision == "NO_GO_DATA_INTEGRITY"
    assert "COLLECTOR_IDENTITY_NOT_PROVEN" in r.findings
    assert r.recorded_receipts_mxn == 0


def test_under_collection_and_over_collection_are_not_reconciled():
    for value in ("499.99", "500.01"):
        order = delivered()
        order["cash_collected"] = value
        r = preview([order])
        assert r.recorded_receipts_mxn == 0
        assert "CASH_COLLECTION_NOT_RECONCILED" in r.findings


def test_cross_beneficiary_credit_never_offsets_driver_cash():
    r = preview([delivered()], [credit(beneficiary=8)])
    assert r.decision == "NO_GO_DATA_INTEGRITY"
    assert "CROSS_BENEFICIARY_NETTING_FORBIDDEN" in r.findings
    assert r.hypothetical_same_payee_offset_mxn == 0


def test_pending_psp_credit_excluded_even_with_same_beneficiary():
    r = preview([delivered()], [credit(status="pending")])
    assert "UNCONFIRMED_PSP_CREDIT_EXCLUDED" in r.findings
    assert r.hypothetical_same_payee_offset_mxn == 0
    assert not r.execute_netting


def test_duplicate_receipt_and_duplicate_psp_reference_rejected():
    a = preview([delivered(), delivered()])
    assert "DUPLICATE_OR_INVALID_ORDER_ID" in a.findings
    b = preview([delivered()], [credit(), credit()])
    assert "DUPLICATE_OR_INVALID_CREDIT_REF" in b.findings
    assert b.hypothetical_same_payee_offset_mxn == 0


def test_hypothetical_credit_capped_at_cash_receipts_not_executed():
    r = preview([delivered(value="100.00")],
                [credit(value="400.00")])
    assert r.hypothetical_same_payee_offset_mxn == Decimal("100")
    assert r.execute_netting is False


def test_untrusted_amounts_and_collector_fail_closed():
    for invalid in ("NaN", "-0.01", "1.234", True, None, float("inf")):
        with pytest.raises(ValueError):
            amount(invalid)
    with pytest.raises(ValueError):
        preview_cash(collector_id=0, orders=[], digital_credits=[], exposure_limit_mxn=100)
    with pytest.raises(ValueError):
        preview([delivered()], limit="0")


def test_readonly_pure_function_never_modifies_inputs():
    orders, credits = [delivered()], [credit()]
    before = deepcopy((orders, credits))
    first = preview(orders, credits)
    second = preview(orders, credits)
    assert first == second
    assert (orders, credits) == before
