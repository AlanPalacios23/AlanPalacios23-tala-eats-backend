"""Phase-1: legacy manually claimed settlement cannot operate in production."""
import asyncio

import pytest
from fastapi import HTTPException

from app.config import settings
from app.routes import operations, v11


@pytest.mark.parametrize("endpoint,kwargs", [
    (operations.generate_payouts, {"admin": None, "db": None}),
    (operations.mark_payout_paid, {"payout_id": 1, "provider_ref": "manual", "admin": None, "db": None}),
    (operations.generate_cash_settlements, {"admin": None, "db": None}),
    (operations.settle_cash, {"settlement_id": 1, "admin": None, "db": None}),
])
def test_legacy_finance_mutations_refuse_prod_before_touching_database(monkeypatch, endpoint, kwargs):
    monkeypatch.setattr(settings, "environment", "production")
    with pytest.raises(HTTPException) as denied:
        endpoint(**kwargs)
    assert denied.value.status_code == 409
    assert "legacy" in denied.value.detail


def test_guard_is_only_a_production_gate(monkeypatch):
    monkeypatch.setattr(settings, "environment", "development")
    assert operations._block_unverified_legacy_finance() is None

def test_v11_legacy_dispatch_requires_bank_reconciliation_before_db_or_psp(monkeypatch):
    monkeypatch.setattr(settings, "environment", "production")
    with pytest.raises(HTTPException) as denied:
        v11.dispatch_payouts(payload=None, admin=None, db=None)
    assert denied.value.status_code == 409
    assert "V11 legacy" in denied.value.detail


def test_v11_legacy_webhook_cannot_self_assert_paid_in_production(monkeypatch):
    monkeypatch.setattr(settings, "environment", "production")
    with pytest.raises(HTTPException) as denied:
        asyncio.run(v11.payout_webhook(request=None, db=None))
    assert denied.value.status_code == 409
    assert "V11 legacy" in denied.value.detail
