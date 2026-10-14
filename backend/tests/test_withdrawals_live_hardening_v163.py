"""Additional LIVE safety regression checks. No external Stripe requests are made."""
from datetime import datetime, timezone
import time
from unittest.mock import Mock
import pytest
from fastapi import HTTPException
from sqlalchemy import select
from app.config import settings
from app import models
from app.routes import withdrawals as w
from app.security import _totp_code
from test_withdrawals_v163 import scenario  # fixture imports for isolated test DB


def _request(s, amount, key):
    return w.request_withdrawal("restaurant", s.rest.id,
        w.RequestPayout(amount_cents=amount,
                        totp=_totp_code(s.owner.totp_secret, int(time.time() // 30))),
        key, s.owner, s.db)


def test_live_execution_requires_explicit_separate_switch(scenario, monkeypatch):
    s = scenario
    monkeypatch.setattr(settings, "stripe_secret_key", "sk_live_fake_do_not_use")
    monkeypatch.setattr(settings, "withdrawals_execution_enabled", True)
    monkeypatch.setattr(settings, "withdrawals_live_enabled", False)
    monkeypatch.setattr(settings, "withdrawals_approved_accounts", [s.rest.payout_account_ref])
    with pytest.raises(HTTPException) as exc:
        _request(s, 1000, "live_switch_closed_1234")
    assert exc.value.status_code == 503
    assert s.provider.calls == 0


def test_live_accounts_must_be_individually_approved(scenario, monkeypatch):
    s = scenario
    monkeypatch.setattr(settings, "stripe_secret_key", "sk_live_fake_do_not_use")
    monkeypatch.setattr(settings, "withdrawals_live_enabled", True)
    monkeypatch.setattr(settings, "withdrawals_approved_accounts", ["acct_ABCDEF00000000"])
    with pytest.raises(HTTPException) as exc:
        w.balance("restaurant", s.rest.id, s.owner, s.db)
    assert exc.value.status_code == 409


def test_unverified_restaurant_blocks_withdrawals(scenario):
    s = scenario
    s.rest.verification_status = "pending"
    s.db.commit()
    with pytest.raises(HTTPException) as exc:
        w.balance("restaurant", s.rest.id, s.owner, s.db)
    assert exc.value.status_code == 409


def test_per_request_limit_blocks_before_stripe(scenario, monkeypatch):
    s = scenario
    monkeypatch.setattr(settings, "withdrawals_execution_enabled", True)
    monkeypatch.setattr(settings, "withdrawals_max_request_cents", 1500)
    with pytest.raises(HTTPException) as exc:
        _request(s, 1501, "request_limit_123456")
    assert exc.value.status_code == 409
    assert s.provider.calls == 0


def test_daily_cap_includes_prior_paid_requests(scenario, monkeypatch):
    s = scenario
    monkeypatch.setattr(settings, "withdrawals_execution_enabled", True)
    monkeypatch.setattr(settings, "withdrawals_max_daily_cents", 4500)
    s.db.add(models.WithdrawalRequest(
        payee_type="restaurant", payee_id=s.rest.id, requested_by=s.owner.id,
        connected_account_id=s.rest.payout_account_ref, client_key="older_daily_paid_12345",
        amount_cents=4000, otp_step=1, status="paid", created_at=datetime.now(timezone.utc)))
    s.db.commit()
    with pytest.raises(HTTPException) as exc:
        _request(s, 1000, "daily_limit_key_123456")
    assert exc.value.status_code == 409
    assert s.provider.calls == 0


def test_same_key_idempotent_replay_does_not_need_fresh_otp(scenario, monkeypatch):
    s=scenario
    monkeypatch.setattr(settings, "withdrawals_execution_enabled", True)
    key="replay_original_key_1234"
    first=_request(s,1000,key)
    second=w.request_withdrawal("restaurant",s.rest.id,
        w.RequestPayout(amount_cents=1000,totp="000000"),key,s.owner,s.db)
    assert first["id"] == second["id"]
    assert s.provider.calls == 1


def test_rate_limiter_fail_closed_in_production(scenario, monkeypatch):
    s=scenario
    monkeypatch.setattr(settings,"environment","production")
    monkeypatch.setattr(w,"redis_client",lambda:None)
    with pytest.raises(HTTPException) as exc:
        w._rate_limit_2fa(s.owner.id,"restaurant",s.rest.id)
    assert exc.value.status_code == 503


def test_rate_limiter_blocks_more_than_five_attempts(scenario, monkeypatch):
    s=scenario
    monkeypatch.setattr(settings,"environment","production")
    r=Mock()
    pipe=Mock()
    pipe.execute.side_effect=[[i] for i in range(1,7)]
    r.pipeline.return_value=pipe
    monkeypatch.setattr(w,"redis_client",lambda:r)
    for i in range(5):
        assert w._rate_limit_2fa(s.owner.id,"restaurant",s.rest.id) is None
    with pytest.raises(HTTPException) as exc:
        w._rate_limit_2fa(s.owner.id,"restaurant",s.rest.id)
    assert exc.value.status_code == 429


def test_connect_payout_unverified_balance_rejects(scenario):
    s=scenario
    original=s.provider.account
    s.provider.v1.accounts.retrieve=lambda acct: {**original(acct),"requirements":{"currently_due":["external_account"]}}
    with pytest.raises(HTTPException) as exc:
        w.balance("restaurant",s.rest.id,s.owner,s.db)
    assert exc.value.status_code == 409


def _emit_payout_webhook(s, monkeypatch, *, eid="evt_hardened_signed_123", kind="payout.paid", status="paid", metadata=None):
    import json, asyncio, sys
    from types import SimpleNamespace
    from starlette.requests import Request
    row=s.db.scalar(select(models.WithdrawalRequest).order_by(models.WithdrawalRequest.id.desc()).limit(1))
    class Webhook:
        @staticmethod
        def construct_event(raw, sig, secret, tolerance):
            assert sig=="signed-from-stripe" and secret=="whsec_mock_signed_events"
            return json.loads(raw)
    monkeypatch.setitem(sys.modules,"stripe",SimpleNamespace(Webhook=Webhook))
    s.provider.v1.payouts.retrieve=lambda payout_id,*,options: {
        "id":payout_id,"amount":row.amount_cents,"currency":"mxn","status":status,"automatic":False,
        "metadata":metadata if metadata is not None else {
            "tala_withdrawal_id":str(row.id),"payee_type":row.payee_type,"payee_id":str(row.payee_id)}}
    payload=json.dumps({"id":eid,"account":row.connected_account_id,"livemode":False,
        "type":kind,"data":{"object":{"id":"po_signed_pending_12345","amount":row.amount_cents,
                                          "currency":"mxn","metadata":{"tala_withdrawal_id":str(row.id)}}}}).encode()
    async def receive():return {"type":"http.request","body":payload,"more_body":False}
    scope={"type":"http","method":"POST","path":"/api/v1/withdrawals/stripe-connect/webhook",
        "headers":[(b"stripe-signature",b"signed-from-stripe")]}
    return asyncio.run(w.connect_webhook(Request(scope,receive),s.db))


def test_stripe_event_cannot_claim_bank_payout_with_wrong_metadata(scenario,monkeypatch):
    s=scenario
    s.db.add(models.WithdrawalRequest(payee_type="restaurant",payee_id=s.rest.id,
        requested_by=s.owner.id,connected_account_id=s.rest.payout_account_ref,
        client_key="payout_spoof_guard_1234",amount_cents=1000,otp_step=1,status="reserved"))
    s.db.commit()
    with pytest.raises(HTTPException) as exc:
        _emit_payout_webhook(s,monkeypatch,metadata={"tala_withdrawal_id":"999","payee_type":"restaurant","payee_id":str(s.rest.id)})
    assert exc.value.status_code==409
    row=s.db.scalar(select(models.WithdrawalRequest))
    assert row.status=="reserved" and row.stripe_payout_id is None


def test_terminal_webhook_must_match_stripe_authoritative_status(scenario,monkeypatch):
    s=scenario
    s.db.add(models.WithdrawalRequest(payee_type="restaurant",payee_id=s.rest.id,
        requested_by=s.owner.id,connected_account_id=s.rest.payout_account_ref,
        client_key="payout_stale_event_1234",amount_cents=1000,otp_step=1,status="reserved"))
    s.db.commit()
    with pytest.raises(HTTPException) as exc:
        _emit_payout_webhook(s,monkeypatch,status="pending")
    assert exc.value.status_code==503
    row=s.db.scalar(select(models.WithdrawalRequest))
    assert row.status=="reserved"


def test_live_requires_full_mexican_stripe_verification(scenario, monkeypatch):
    s=scenario
    monkeypatch.setattr(settings,"stripe_secret_key","sk_live_fake_no_real_key")
    monkeypatch.setattr(settings,"withdrawals_approved_accounts",[s.rest.payout_account_ref])
    original=s.provider.account
    s.provider.v1.accounts.retrieve=lambda acct: {**original(acct), "country":"MX", "details_submitted":False, "requirements":{}}
    with pytest.raises(HTTPException) as exc:
        w.balance("restaurant",s.rest.id,s.owner,s.db)
    assert exc.value.status_code==409
