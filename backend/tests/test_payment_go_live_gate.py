"""Read-only go-live gate: configuration does not authorize real money."""
import json
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from app.config import settings
from app.payment_go_live_gate import assess_payment_go_live, main
from app.routes import operations


def fake(**extra):
    options = dict(
        stripe_enabled=False, stripe_secret_key="", stripe_publishable_key="",
        stripe_webhook_secret="", stripe_connect_enabled=False,
        stripe_connect_webhook_secret="", public_base_url="https://talaeats.example",
        mercado_pago_access_token="", mercado_pago_webhook_secret="",
        withdrawals_preview_enabled=False, withdrawals_execution_enabled=False,
        withdrawals_live_enabled=False, withdrawals_approved_accounts=[],
        withdrawals_approved_bank_destinations=[], cash_checkout_enabled=False,
        finance_v2_shadow_enabled=False,
    )
    options.update(extra)
    return SimpleNamespace(**options)


def fake_live(**extra):
    values = dict(
        stripe_enabled=True, stripe_secret_key="sk_live_CI_DUMMY_NOT_REAL",
        stripe_publishable_key="pk_live_CI_DUMMY_NOT_REAL",
        stripe_webhook_secret="whsec_CI_DUMMY", stripe_connect_enabled=True,
        stripe_connect_webhook_secret="whsec_CONNECT_DUMMY",
        withdrawals_preview_enabled=True, withdrawals_execution_enabled=True,
        withdrawals_live_enabled=True, withdrawals_approved_accounts=["acct_dummy"],
        withdrawals_approved_bank_destinations=["acct_dummy:ba_dummy"],
    )
    values.update(extra)
    return fake(**values)


def test_default_all_money_movement_fails_closed():
    report = assess_payment_go_live(fake())
    assert report["mutates_money_or_configuration"] is False
    assert report["authorizes_real_money_activation"] is False
    assert set(report["flows"]) == {
        "stripe_card_charges", "mercado_pago_checkout", "stripe_connect_transfers",
        "bank_withdrawals", "physical_cash_auto_recovery",
    }
    assert all(not x["automatic_real_money_activation_authorized"]
               for x in report["flows"].values())


def test_live_shaped_keys_do_not_prove_bank_funding():
    result = assess_payment_go_live(fake_live())
    assert result["flows"]["stripe_card_charges"]["configuration_complete"] is True
    assert result["flows"]["stripe_connect_transfers"]["configuration_complete"] is True
    assert result["flows"]["bank_withdrawals"]["configuration_complete"] is True
    assert result["flows"]["bank_withdrawals"]["independent_provider_and_bank_verification"] is False
    assert result["flows"]["physical_cash_auto_recovery"]["configuration_complete"] is False
    assert result["authorizes_real_money_activation"] is False


@pytest.mark.parametrize("bad", [
    {"stripe_publishable_key": "pk_test_wrong_mode"},
    {"stripe_webhook_secret": ""}, {"public_base_url": "http://example.invalid"},
    {"stripe_enabled": False},
])
def test_stripe_mode_mismatches_fail_closed(bad):
    result = assess_payment_go_live(fake_live(**bad))
    assert result["flows"]["stripe_card_charges"]["configuration_complete"] is False


def test_mp_sandbox_token_never_qualifies_as_live():
    x = assess_payment_go_live(fake(mercado_pago_access_token="TEST-fake",
                                    mercado_pago_webhook_secret="fake-secret"))
    assert x["flows"]["mercado_pago_checkout"]["configuration_complete"] is False
    assert "MP_SANDBOX_CREDENTIALS_NOT_LIVE" in x["flows"]["mercado_pago_checkout"]["blockers"]


def test_cash_flag_and_shadow_ledger_cannot_automatically_collect_cash():
    result = assess_payment_go_live(fake(cash_checkout_enabled=True,
                                         finance_v2_shadow_enabled=True))
    assert result["flows"]["physical_cash_auto_recovery"]["configuration_complete"] is False
    assert result["settlement_engine"] == "shadow_only"


def test_report_never_exposes_credentials(monkeypatch, capsys):
    c = fake_live(stripe_secret_key="sk_live_TOP_SECRET",
                  mercado_pago_access_token="APP_USR_SENSITIVE",
                  mercado_pago_webhook_secret="private-mp-secret")
    encoded = json.dumps(assess_payment_go_live(c))
    for secret in ("TOP_SECRET", "SENSITIVE", "private-mp-secret", "acct_dummy"):
        assert secret not in encoded
    monkeypatch.setattr("app.config.settings", c)
    assert main() == 2
    assert json.loads(capsys.readouterr().out)["authorizes_real_money_activation"] is False


@pytest.mark.parametrize("fn,args", [
    (operations.generate_payouts, (None, None)),
    (operations.mark_payout_paid, (7, "fake-ref", None, None)),
    (operations.generate_cash_settlements, (None, None)),
    (operations.settle_cash, (7, "", None, None)),
])
def test_legacy_unverified_money_mutations_forbidden_in_production(monkeypatch, fn, args):
    monkeypatch.setattr(settings, "environment", "production")
    monkeypatch.setattr(settings, "finance_v2_shadow_enabled", False)
    with pytest.raises(HTTPException) as exc:
        fn(*args)
    assert exc.value.status_code == 409


def test_legacy_guard_allows_nonproduction_existing_contract(monkeypatch):
    monkeypatch.setattr(settings, "environment", "development")
    operations._block_unverified_legacy_finance()
