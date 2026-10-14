"""No real-money calls: mobile withdrawal contract & fail-closed bank state."""
from app.config import settings
from app.routes import withdrawals as w
from test_withdrawals_v163 import scenario


def test_bank_absent_blocks_mobile_even_if_money_available(scenario, monkeypatch):
    x = scenario
    monkeypatch.setattr(settings, "withdrawals_execution_enabled", True)
    snapshot = w.balance("restaurant", x.rest.id, x.owner, x.db)
    assert snapshot["withdrawable_cents"] == 8500
    assert snapshot["bank"]["status"] == "unavailable"
    assert snapshot["server_allows_requests"] is False
    assert snapshot["limits"]["minimum_cents"] == 100
    assert "clabe" not in str(snapshot).lower()
    assert "acct_" not in str(snapshot)


def test_bank_authorized_requires_2fa_and_server_write_flag(scenario, monkeypatch):
    x = scenario
    x.provider.accounts.list_external_accounts = lambda acct, params: {
        "has_more": False,
        "data": [{"id": "ba_test_12345678", "object": "bank_account",
                  "status": "new", "country": "MX", "currency": "mxn",
                  "last4": "1234", "bank_name": "Prueba", "default_for_currency": True}],
    }
    snapshot = w.balance("restaurant", x.rest.id, x.owner, x.db)
    assert snapshot["bank"]["status"] == "verified"
    assert snapshot["server_allows_requests"] is False
    monkeypatch.setattr(settings, "withdrawals_execution_enabled", True)
    snapshot = w.balance("restaurant", x.rest.id, x.owner, x.db)
    assert snapshot["server_allows_requests"] is True
    x.owner.two_factor_enabled = False
    snapshot = w.balance("restaurant", x.rest.id, x.owner, x.db)
    assert snapshot["server_allows_requests"] is False


def test_bank_failed_verification_and_missing_last4_fail_closed(scenario, monkeypatch):
    x = scenario
    def bank(acct, params):
        return {"has_more": False, "data": [{"id":"ba_test_12345678",
            "object":"bank_account", "status":"errored",
            "country":"MX", "currency":"mxn", "last4":"1234",
            "default_for_currency":True}]}
    x.provider.accounts.list_external_accounts = bank
    assert w.balance("restaurant", x.rest.id, x.owner, x.db)["bank"]["status"] == "restricted"
    x.provider.accounts.list_external_accounts = lambda acct,params: {
        "has_more":False, "data":[{"id":"ba_test_12345678", "object":"bank_account",
             "status":"new", "country":"MX", "currency":"mxn", "last4":"",
             "default_for_currency":True}]}
    assert w.balance("restaurant", x.rest.id, x.owner, x.db)["server_allows_requests"] is False
