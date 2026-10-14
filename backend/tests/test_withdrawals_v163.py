"""Money safety contract for Stripe Connect withdrawals; never talks to Stripe LIVE."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock
import time
import pytest
from fastapi import HTTPException
from sqlalchemy import select, update

from app import models
from app.config import settings
from app.db import SessionLocal
from app.routes import withdrawals as w
from app.security import _totp_code


@pytest.fixture
def scenario(monkeypatch):
    monkeypatch.setattr(settings, "withdrawals_preview_enabled", True)
    monkeypatch.setattr(settings, "withdrawals_execution_enabled", False)
    monkeypatch.setattr(settings, "withdrawals_min_age_days", 7)
    monkeypatch.setattr(settings, "stripe_enabled", True)
    monkeypatch.setattr(settings, "stripe_connect_enabled", True)
    monkeypatch.setattr(settings, "stripe_connect_webhook_secret", "whsec_mock_signed_events")
    db = SessionLocal()
    owner = db.scalar(select(models.User).where(models.User.role == "restaurant"))
    driver = db.scalar(select(models.User).where(models.User.role == "driver"))
    customer = db.scalar(select(models.User).where(models.User.role == "customer"))
    rest = db.scalar(select(models.Restaurant).where(models.Restaurant.owner_id == owner.id))
    profile = db.scalar(select(models.DriverProfile).where(models.DriverProfile.user_id == driver.id))
    rest.payout_account_ref = "acct_12345678REST"
    profile.payout_account_ref = "acct_12345678DRIV"
    owner.two_factor_enabled = True
    driver.two_factor_enabled = True
    owner.totp_secret = "JBSWY3DPEHPK3PXP"
    driver.totp_secret = "JBSWY3DPEHPK3PXP"
    order = models.Order(user_id=customer.id, restaurant_id=rest.id, driver_id=driver.id,
                         status="delivered", payment_method="stripe", payment_status="paid",
                         payment_provider_id="pi_real_paid123", address="Centro Tala",
                         restaurant_payout=Decimal("85.00"), driver_earning=Decimal("42.00"),
                         tip=Decimal("8.00"), total=Decimal("160.00"),
                         refunded_amount=Decimal("0.00"), order_type="delivery",
                         delivered_at=datetime.now(timezone.utc)-timedelta(days=10))
    db.add(order)
    db.flush()
    db.add_all([
        models.StripeTransfer(order_id=order.id, recipient_type="restaurant", connected_account_id=rest.payout_account_ref,
                              amount_cents=8500, transfer_id="tr_resta_valid", status="completed"),
        models.StripeTransfer(order_id=order.id, recipient_type="driver", connected_account_id=profile.payout_account_ref,
                              amount_cents=5000, transfer_id="tr_driver_valid", status="completed"),
    ])
    db.commit()
    class FakeStripe:
        def __init__(self):
            self.calls = 0
            self.payouts = []
            self.available = 12000
            self.interval = "manual"
            self.destination = rest.payout_account_ref
            self.reversed = 0
            self.transfer_amount = 8500
            self.transfers = SimpleNamespace(retrieve=self.transfer)
            self.charges = SimpleNamespace(retrieve=self.charge)
            self.refunded=0
            self.disputed=False
            self.accounts = SimpleNamespace(retrieve=self.account)
            self.balance = SimpleNamespace(retrieve=self.getbalance)
            self.payouts_api = SimpleNamespace(list=self.list, create=self.create, retrieve=self.retrieve_payout)
            self.v1 = SimpleNamespace(transfers=self.transfers, charges=self.charges, accounts=self.accounts,
                                      balance=self.balance, payouts=self.payouts_api)
        def transfer(self, key):
            return {"id":key,"destination":self.destination,"currency":"mxn",
                    "amount":self.transfer_amount,"amount_reversed":self.reversed,"source_transaction":"ch_123456"}
        def charge(self, key):
            return {"id":key,"payment_intent":"pi_real_paid123","currency":"mxn","amount":16000,
                    "paid":True,"captured":True,"amount_refunded":self.refunded,"disputed":self.disputed}
        def account(self, key):
            return {"id":key,"payouts_enabled":True,"settings":{"payouts":{"schedule":{"interval":self.interval}}}}
        def getbalance(self, *, options):
            return {"available":[{"currency":"mxn","source_types":{"card":self.available}}]}
        def list(self, obj, *, options):
            return {"data":self.payouts, "has_more":False}
        def retrieve_payout(self, payout_id, *, options):
            self.calls += 0  # A Stripe read is NOT a new bank payout.
            with SessionLocal() as session:
                record = session.scalar(select(models.WithdrawalRequest).where(
                    models.WithdrawalRequest.stripe_payout_id == payout_id))
                if record is None:
                    # The webhook can arrive before POST stores the Stripe ID.
                    record = session.scalar(select(models.WithdrawalRequest).order_by(
                        models.WithdrawalRequest.id.desc()).limit(1))
                assert record is not None
                return {"id": payout_id, "amount": record.amount_cents, "currency": "mxn",
                        "status": "paid", "livemode": False, "automatic": False,
                        "metadata": {"tala_withdrawal_id": str(record.id),
                                     "payee_type": record.payee_type,
                                     "payee_id": str(record.payee_id)}}
        def create(self, body, *, options):
            self.calls += 1
            return {"id":"po_mock_confirmable_123", "currency":"mxn",
                    "amount":body["amount"],"status":"pending"}
    provider = FakeStripe()
    monkeypatch.setattr(w, "stripe_client", lambda: provider)
    yield SimpleNamespace(db=db, rest=rest, owner=owner, driver=driver, profile=profile,
                          order=order, provider=provider)
    db.close()


def test_balance_separate_merchant_and_driver(scenario):
    x=scenario
    assert w.balance("restaurant",x.rest.id, x.owner, x.db)["withdrawable_cents"] == 8500
    x.provider.destination = x.profile.payout_account_ref
    x.provider.transfer_amount = 5000
    assert w.balance("driver",x.driver.id,x.driver,x.db)["withdrawable_cents"] == 5000


def test_unrelated_actor_cannot_read_balance(scenario):
    x=scenario
    with pytest.raises(HTTPException) as e:
        w.balance("restaurant",x.rest.id,x.driver,x.db)
    assert e.value.status_code == 404


def test_cash_not_a_credited_balance(scenario):
    x=scenario
    x.order.payment_method="cash";x.db.commit()
    assert w.balance("restaurant",x.rest.id,x.owner,x.db)["withdrawable_cents"] == 0


@pytest.mark.parametrize("field,value",[("status","preparing"),("payment_status","pending"),
                                       ("payment_status","refunded"),("payment_status","disputed"),
                                       ("refunded_amount",Decimal("10.00"))])
def test_funds_never_credited_for_unsettled_refunded_or_disputed(scenario,field,value):
    x=scenario
    x.db.execute(update(models.Order).where(models.Order.id == x.order.id).values({field: value}), execution_options={"synchronize_session":False});x.db.commit()
    assert w.balance("restaurant",x.rest.id,x.owner,x.db)["withdrawable_cents"] == 0


def test_hold_period(scenario):
    x=scenario
    x.order.delivered_at=datetime.now(timezone.utc)-timedelta(days=2);x.db.commit()
    assert w.balance("restaurant",x.rest.id,x.owner,x.db)["withdrawable_cents"] == 0


def test_transfer_reversed_at_provider_is_rejected(scenario):
    x=scenario;x.provider.reversed=100
    with pytest.raises(HTTPException) as e:
        w.balance("restaurant",x.rest.id,x.owner,x.db)
    assert e.value.status_code == 409


def test_transfer_amount_mismatch_not_credited(scenario):
    x=scenario
    t=x.db.scalar(select(models.StripeTransfer).where(models.StripeTransfer.recipient_type=="restaurant"))
    t.amount_cents=9500;x.db.commit()
    assert w.balance("restaurant",x.rest.id,x.owner,x.db)["withdrawable_cents"] == 0


def test_available_remote_funds_limit(scenario):
    x=scenario;x.provider.available=3800
    assert w.balance("restaurant",x.rest.id,x.owner,x.db)["withdrawable_cents"] == 3800


def test_automatic_schedule_fails_closed(scenario):
    x=scenario;x.provider.interval="daily"
    with pytest.raises(HTTPException) as e:
        w.balance("restaurant",x.rest.id,x.owner,x.db)
    assert e.value.status_code==409


def test_unknown_stripe_payout_fails_closed(scenario):
    x=scenario;x.provider.payouts=[{"id":"po_external", "automatic":False}]
    with pytest.raises(HTTPException) as e:
        w.balance("restaurant",x.rest.id,x.owner,x.db)
    assert e.value.status_code==409


def test_old_admin_payout_fails_closed(scenario):
    x=scenario
    x.db.add(models.Payout(payee_type="restaurant",payee_id=x.rest.id,amount=Decimal("1.00"),
                           period_start=datetime.now(timezone.utc)-timedelta(days=10),period_end=datetime.now(timezone.utc)))
    x.db.commit()
    with pytest.raises(HTTPException) as e:
        w.balance("restaurant",x.rest.id,x.owner,x.db)
    assert e.value.status_code==409


def test_no_execution_unless_explicitly_enabled(scenario):
    x=scenario
    with pytest.raises(HTTPException) as e:
        w.request_withdrawal("restaurant",x.rest.id,w.RequestPayout(amount_cents=1000,totp="123456"),
                             "16digitvalidkey_123",x.owner,x.db)
    assert e.value.status_code==503
    assert x.provider.calls==0


def test_request_two_factor_and_idempotency_and_holds(scenario,monkeypatch):
    x=scenario
    monkeypatch.setattr(settings,"withdrawals_execution_enabled",True)
    otp=_totp_code(x.owner.totp_secret,int(time.time()//30))
    with pytest.raises(HTTPException) as e:
        w.request_withdrawal("restaurant",x.rest.id,w.RequestPayout(amount_cents=1000,totp="123456"),
                             "16digitvalidkey_123",x.owner,x.db)
    assert e.value.status_code==403
    body=w.RequestPayout(amount_cents=1000,totp=otp)
    result=w.request_withdrawal("restaurant",x.rest.id,body,"16digitvalidkey_123",x.owner,x.db)
    assert result["amount_cents"]==1000 and result["status"]=="submitted"
    assert x.provider.calls==1
    result2=w.request_withdrawal("restaurant",x.rest.id,body,"16digitvalidkey_123",x.owner,x.db)
    assert result2["id"]==result["id"] and x.provider.calls==1
    with pytest.raises(HTTPException) as e:
        w.request_withdrawal("restaurant",x.rest.id,body,"validkey_other_123",x.owner,x.db)
    assert e.value.status_code==409


def test_provider_timeout_keeps_money_reserved(scenario,monkeypatch):
    x=scenario
    monkeypatch.setattr(settings,"withdrawals_execution_enabled",True)
    x.provider.v1.payouts.create=lambda *args,**kwargs: (_ for _ in ()).throw(TimeoutError("network"))
    otp=_totp_code(x.owner.totp_secret,int(time.time()//30))
    with pytest.raises(HTTPException) as e:
        w.request_withdrawal("restaurant",x.rest.id,w.RequestPayout(amount_cents=5000,totp=otp),
                             "validkey_timeout_123",x.owner,x.db)
    assert e.value.status_code==503
    req=x.db.scalar(select(models.WithdrawalRequest))
    assert req.status=="unknown" and req.amount_cents==5000
    assert w._reserved(x.db,"restaurant",x.rest.id)==5000


def test_open_cash_debt_blocks_driver(scenario):
    x=scenario
    x.db.add(models.CashSettlement(driver_id=x.driver.id, cash_collected=Decimal("100.00"),
                                   amount_due_platform=Decimal("75.00"),status="open"))
    x.db.commit()
    x.provider.destination=x.profile.payout_account_ref
    x.provider.transfer_amount=5000
    with pytest.raises(HTTPException) as e:
        w.balance("driver",x.driver.id,x.driver,x.db)
    assert e.value.status_code==409


def test_feature_default_off_fails_closed(scenario,monkeypatch):
    x=scenario
    monkeypatch.setattr(settings,"withdrawals_preview_enabled",False)
    with pytest.raises(HTTPException) as e:
        w.balance("restaurant",x.rest.id,x.owner,x.db)
    assert e.value.status_code==503


def test_one_connect_account_cannot_belong_to_two_restaurants(scenario):
    x=scenario
    second=x.db.scalar(select(models.Restaurant).where(models.Restaurant.id != x.rest.id))
    second.payout_account_ref=x.rest.payout_account_ref
    x.db.commit()
    with pytest.raises(HTTPException) as e:
        w.balance("restaurant",x.rest.id,x.owner,x.db)
    assert e.value.status_code==409


def test_existing_unknown_request_blocks_following_payout_even_if_stripe_available(scenario):
    x=scenario
    x.db.add(models.WithdrawalRequest(payee_type="restaurant",payee_id=x.rest.id,requested_by=x.owner.id,
            connected_account_id=x.rest.payout_account_ref,client_key="first_live_request_1234",
            amount_cents=3000,otp_step=1,status="unknown"))
    x.db.commit()
    assert w._reserved(x.db,"restaurant",x.rest.id)==3000
    assert w.balance("restaurant",x.rest.id,x.owner,x.db)["withdrawable_cents"]==5500


def test_webhook_ignores_unknown_payout_and_never_moves_money(scenario,monkeypatch):
    import asyncio, json, sys
    from starlette.requests import Request
    x=scenario
    body={"id":"evt_webhook_123", "account":x.rest.payout_account_ref,
          "livemode": False,"type":"payout.paid",
          "data":{"object":{"id":"po_does_not_exist","amount":2000,"currency":"mxn",
                             "metadata":{"tala_withdrawal_id":"999999"}}}}
    class Webhook:
        @staticmethod
        def construct_event(raw,sig,secret,tolerance):
            assert sig=="test-signature" and secret=="whsec_mock_signed_events"
            return json.loads(raw)
    monkeypatch.setitem(sys.modules,"stripe",SimpleNamespace(Webhook=Webhook))
    raw=json.dumps(body).encode()
    async def receive():return {"type":"http.request","body":raw,"more_body":False}
    scope={"type":"http","method":"POST","path":"/api/v1/withdrawals/stripe-connect/webhook",
           "headers":[(b"stripe-signature",b"test-signature")]}
    response=asyncio.run(w.connect_webhook(Request(scope,receive),x.db))
    assert response["received"] is True
    assert x.db.scalar(select(models.WithdrawalRequest.id)) is None
    assert x.db.scalar(select(models.PaymentEvent.id).where(models.PaymentEvent.provider=="stripe_connect")) is not None


def test_webhook_paid_then_failed_never_releases_balance_automatically(scenario,monkeypatch):
    import asyncio, json, sys
    from starlette.requests import Request
    x=scenario
    row=models.WithdrawalRequest(payee_type="restaurant",payee_id=x.rest.id,requested_by=x.owner.id,
                                  connected_account_id=x.rest.payout_account_ref,client_key="original_bank_payout123",
                                  amount_cents=3000,otp_step=1,status="submitted",stripe_payout_id="po_bank_test_123")
    x.db.add(row);x.db.commit()
    class Webhook:
        @staticmethod
        def construct_event(raw,sig,secret,tolerance):
            return json.loads(raw)
    monkeypatch.setitem(sys.modules,"stripe",SimpleNamespace(Webhook=Webhook))
    statuses = iter(["paid", "failed"])
    def retrieve_status(payout_id, *, options):
        return {"id": payout_id, "amount": 3000, "currency": "mxn",
                "status": next(statuses), "livemode": False,
                "metadata": {"tala_withdrawal_id": str(row.id),
                             "payee_type": "restaurant", "payee_id": str(x.rest.id)}}
    x.provider.v1.payouts.retrieve = retrieve_status
    async def event(kind, eid):
        payload=json.dumps({"id":eid,"account":x.rest.payout_account_ref,"livemode":False,
                            "type":kind,"data":{"object":{"id":"po_bank_test_123", "currency":"mxn",
                               "amount":3000,"metadata":{"tala_withdrawal_id":str(row.id)}}}}).encode()
        async def receive():return {"type":"http.request","body":payload,"more_body":False}
        scope={"type":"http","method":"POST","path":"/api/v1/withdrawals/stripe-connect/webhook",
               "headers":[(b"stripe-signature",b"test-signature")]}
        return await w.connect_webhook(Request(scope,receive),x.db)
    asyncio.run(event("payout.paid","evt_pay_confirmed_1"))
    x.db.refresh(row)
    assert row.status=="paid"
    assert x.db.scalar(select(models.FinancialLedgerEntry.id).where(models.FinancialLedgerEntry.kind=="withdrawal_paid"))
    asyncio.run(event("payout.paid","evt_pay_confirmed_1"))
    assert x.db.scalar(select(models.FinancialLedgerEntry.id).where(models.FinancialLedgerEntry.kind=="withdrawal_paid"))
    asyncio.run(event("payout.failed","evt_pay_failed_2"))
    x.db.refresh(row)
    assert row.status=="review_required"
    assert w._reserved(x.db,"restaurant",x.rest.id)==3000
    assert x.db.scalar(select(models.FinancialLedgerEntry.id).where(models.FinancialLedgerEntry.kind=="withdrawal_reversal"))


def test_totp_cannot_authorize_two_withdrawals_even_if_first_paid(scenario, monkeypatch):
    x = scenario
    monkeypatch.setattr(settings, "withdrawals_execution_enabled", True)
    otp = _totp_code(x.owner.totp_secret, int(time.time() // 30))
    body = w.RequestPayout(amount_cents=1000, totp=otp)
    first = w.request_withdrawal("restaurant", x.rest.id, body, "separate_key_original_123", x.owner, x.db)
    row = x.db.get(models.WithdrawalRequest, first["id"])
    row.status = "paid"
    x.db.commit()
    with pytest.raises(HTTPException) as exc:
        w.request_withdrawal("restaurant", x.rest.id, body, "separate_key_second__123", x.owner, x.db)
    assert exc.value.status_code == 409
    assert x.provider.calls == 1


def test_charge_refunded_or_disputed_on_stripe_blocks_even_if_local_paid(scenario):
    x=scenario
    x.provider.refunded=100
    with pytest.raises(HTTPException) as e:
        w.balance("restaurant",x.rest.id,x.owner,x.db)
    assert e.value.status_code==409
    x.provider.refunded=0
    x.provider.disputed=True
    with pytest.raises(HTTPException) as e:
        w.balance("restaurant",x.rest.id,x.owner,x.db)
    assert e.value.status_code==409
