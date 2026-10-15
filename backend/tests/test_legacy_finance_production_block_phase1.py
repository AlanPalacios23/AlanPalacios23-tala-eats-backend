"""Phase-1: legacy manually claimed settlement cannot operate in production."""
import pytest
from fastapi import HTTPException

from app.config import settings
from app.routes import operations


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
