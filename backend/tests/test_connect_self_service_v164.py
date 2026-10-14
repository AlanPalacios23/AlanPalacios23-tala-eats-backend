"""Fail-closed user-owned Stripe Connect onboarding: no real Stripe network."""
from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from fastapi import HTTPException
from sqlalchemy import select
from app import models
from app.config import settings
from app.db import SessionLocal
from app.routes import withdrawals as w

ACCOUNT_ID = 'acct_TestSelfSvcA1234'

@pytest.fixture
def user_setup(monkeypatch):
    with SessionLocal() as db:
        owner = db.scalar(select(models.User).where(models.User.role == 'restaurant'))
        restaurant = db.scalar(select(models.Restaurant).where(models.Restaurant.owner_id == owner.id))
        restaurant.verification_status = 'verified'
        restaurant.onboarding_status = 'approved'
        restaurant.payout_account_ref = ''
        db.commit()
        db.refresh(owner); db.refresh(restaurant)
        monkeypatch.setattr(settings, 'stripe_enabled', True)
        monkeypatch.setattr(settings, 'stripe_connect_self_service_enabled', True)
        monkeypatch.setattr(settings, 'stripe_secret_key', 'sk_test_dummy')
        monkeypatch.setattr(settings, 'stripe_webhook_secret', 'whsec_dummy')
        api=SimpleNamespace(
            accounts=SimpleNamespace(
                create=Mock(return_value={'id': ACCOUNT_ID, 'country': 'MX'}),
                retrieve=Mock(return_value={'id': ACCOUNT_ID, 'country': 'MX', 'details_submitted': False,
                                            'payouts_enabled': False, 'capabilities': {'transfers':'inactive'}}),
                list_external_accounts=Mock(return_value={'has_more':False,'data':[]}),
                create_login_link=Mock(return_value={'url':'https://connect.stripe.com/express/test'}),
            ),
            account_links=SimpleNamespace(create=Mock(return_value={'url':'https://connect.stripe.com/setup/c/test','expires_at':99999}))
        )
        monkeypatch.setattr(w, 'stripe_client', lambda:SimpleNamespace(v1=api))
        monkeypatch.setattr(w, '_connect_step_up', lambda *args, **kwargs: None)
        yield SimpleNamespace(db=db,owner=owner,restaurant=restaurant,api=api)


def test_stripe_disabled_blocks_before_creation(user_setup,monkeypatch):
    x=user_setup;monkeypatch.setattr(settings,'stripe_connect_self_service_enabled',False)
    with pytest.raises(HTTPException) as err:
        w.connect_self_service_onboarding('restaurant',x.restaurant.id,x.owner,x.db)
    assert err.value.status_code==503
    x.api.accounts.create.assert_not_called()


def test_unauthorized_user_not_allowed(user_setup):
    x=user_setup
    wrong=x.db.scalar(select(models.User).where(models.User.role=='customer'))
    with pytest.raises(HTTPException) as err:
        w.connect_self_service_onboarding('restaurant',x.restaurant.id,wrong,x.db)
    assert err.value.status_code == 404
    x.api.accounts.create.assert_not_called()


def test_create_exactly_once_and_reuse_verified_owner(user_setup):
    x=user_setup
    first=w.connect_self_service_onboarding('restaurant',x.restaurant.id,x.owner,x.db)
    assert first['url'].startswith('https://connect.stripe.com/')
    assert x.restaurant.payout_account_ref == ACCOUNT_ID
    assert x.api.accounts.create.call_count == 1
    assert x.api.accounts.create.call_args.args[0]["settings"]["payouts"]["schedule"]["interval"] == "manual"
    second=w.connect_self_service_onboarding('restaurant',x.restaurant.id,x.owner,x.db)
    assert second['url'] == first['url']
    assert x.api.accounts.create.call_count == 1


def test_provider_untrusted_redirect_blocked(user_setup):
    x=user_setup
    x.api.account_links.create.return_value={'url':'https://evil.example/login'}
    with pytest.raises(HTTPException) as err:
        w.connect_self_service_onboarding('restaurant',x.restaurant.id,x.owner,x.db)
    assert err.value.status_code==502
    assert x.restaurant.payout_account_ref == ACCOUNT_ID


def test_status_no_fake_available_balance(user_setup):
    x=user_setup
    result=w.connect_self_service_status('restaurant',x.restaurant.id,x.owner,x.db)
    assert result == {'status':'not_linked','bank': {'status':'not_linked'}, 'can_withdraw':False,'action':'start_onboarding'}
    w.connect_self_service_onboarding('restaurant',x.restaurant.id,x.owner,x.db)
    status=w.connect_self_service_status('restaurant',x.restaurant.id,x.owner,x.db)
    assert status['can_withdraw'] is False
    assert status['status']=='pending_verification'
    assert 'withdrawable_cents' not in status


def test_no_bank_identifiers_or_clabe_in_status(user_setup):
    x=user_setup
    w.connect_self_service_onboarding('restaurant',x.restaurant.id,x.owner,x.db)
    x.api.accounts.retrieve.return_value={'id':ACCOUNT_ID,'country':'MX','payouts_enabled':True,'details_submitted':True,
        'capabilities':{'transfers':'active'},'settings':{'payouts':{'schedule':{'interval':'manual'}}},'requirements':{'currently_due':[],'past_due':[]}}
    x.api.accounts.list_external_accounts.return_value={'has_more':False,'data':[{'id':'ba_test1234567',
        'object':'bank_account','country':'MX','currency':'mxn','last4':'7878','bank_name':'Banco Test',
        'account_number':'123456789012345678'}]}
    status=w.connect_self_service_status('restaurant',x.restaurant.id,x.owner,x.db)
    assert status['status']=='verified'
    assert status['can_withdraw'] is False
    assert '123456789012345678' not in str(status)
    assert 'ba_test1234567' not in str(status)


def test_bank_link_not_authorizing_payout(user_setup,monkeypatch):
    x=user_setup;w.connect_self_service_onboarding('restaurant',x.restaurant.id,x.owner,x.db)
    assert settings.withdrawals_execution_enabled is False
    assert settings.withdrawals_live_enabled is False
    with pytest.raises(HTTPException):
        w.request_withdrawal('restaurant',x.restaurant.id,w.RequestPayout(amount_cents=100,totp='123456'),
                             'abc12345678901234567',x.owner,x.db)
