"""Bank destination approval regression. No Stripe network calls or real transfers."""
from unittest.mock import Mock
from sqlalchemy import select
from fastapi import HTTPException
from app.config import settings
from app import models
from app.routes import withdrawals as w
from test_withdrawals_v163 import scenario
from test_withdrawals_live_hardening_v163 import _request, _emit_payout_webhook
import pytest


def _live(s, monkeypatch, bank="ba_1234567890BANK"):
    monkeypatch.setattr(settings, 'stripe_secret_key', 'sk_live_fake_do_not_use')
    monkeypatch.setattr(settings, 'withdrawals_live_enabled', True)
    monkeypatch.setattr(settings, 'withdrawals_execution_enabled', True)
    monkeypatch.setattr(settings, 'withdrawals_approved_accounts', [s.rest.payout_account_ref])
    monkeypatch.setattr(settings, 'withdrawals_approved_bank_destinations', [f'{s.rest.payout_account_ref}:{bank}'])
    account = s.provider.account
    def live_account(acct):
        return {**account(acct), 'country':'MX', 'details_submitted':True,
                'requirements':{'currently_due':[], 'past_due':[], 'disabled_reason':None}}
    s.provider.v1.accounts.retrieve = live_account
    s.provider.payouts = []
    return bank


def test_live_bank_approval_missing_blocks_before_provider(scenario, monkeypatch):
    s=scenario
    _live(s,monkeypatch)
    monkeypatch.setattr(settings, 'withdrawals_approved_bank_destinations', [])
    with pytest.raises(HTTPException) as exc: _request(s,1000,'no_bank_live_1234567')
    assert exc.value.status_code==503
    assert s.provider.calls==0


def test_live_wrong_account_bank_approval_denies(scenario,monkeypatch):
    s=scenario
    _live(s,monkeypatch)
    monkeypatch.setattr(settings,'withdrawals_approved_bank_destinations',['acct_OTHERACCOUNT123:ba_1234567890BANK'])
    with pytest.raises(HTTPException) as exc: _request(s,1000,'wrong_bank_acct_12345')
    assert exc.value.status_code==409 and s.provider.calls==0


def test_live_payout_pins_destination_and_verifies_provider_response(scenario,monkeypatch):
    s=scenario
    bank=_live(s,monkeypatch)
    seen=[]
    def create(body,*,options):
        seen.append((body,options))
        return {'id':'po_live_12345678','currency':'mxn', 'amount':body['amount'],
                'status':'pending','livemode':True,'automatic':False,'destination':bank,
                'metadata':body['metadata']}
    s.provider.v1.payouts.create=create
    result=_request(s,1000,'approved_live_bank_1234')
    assert result['status']=='submitted'
    assert seen[0][0]['destination']==bank
    assert seen[0][1]['stripe_account']==s.rest.payout_account_ref
    row=s.db.scalar(select(models.WithdrawalRequest))
    assert row.bank_destination_id==bank



def test_live_payout_response_missing_metadata_keeps_reservation(scenario,monkeypatch):
    s=scenario
    bank=_live(s,monkeypatch)
    s.provider.v1.payouts.create=lambda body,*,options: {
        'id':'po_no_metadata_12345','currency':'mxn','amount':body['amount'],
        'status':'pending','livemode':True,'destination':bank}
    with pytest.raises(HTTPException) as exc: _request(s,1000,'metadata_required_live_1234')
    assert exc.value.status_code==503
    row=s.db.scalar(select(models.WithdrawalRequest))
    assert row.status=='unknown' and row.bank_destination_id==bank

def test_live_wrong_bank_response_keeps_funds_reserved(scenario,monkeypatch):
    s=scenario
    bank=_live(s,monkeypatch)
    def create(body,*,options):
        return {'id':'po_live_87654321','currency':'mxn','amount':body['amount'],
                'status':'pending','livemode':True,'destination':'ba_WRONGBANK987654'}
    s.provider.v1.payouts.create=create
    with pytest.raises(HTTPException) as exc: _request(s,1000,'wrong_bank_response_1234')
    assert exc.value.status_code==503
    row=s.db.scalar(select(models.WithdrawalRequest))
    assert row.status=='unknown' and row.bank_destination_id==bank
    assert w._reserved(s.db,'restaurant',s.rest.id)==1000


def test_live_approval_rotation_cannot_replay_payout_under_new_bank(scenario,monkeypatch):
    s=scenario
    bank=_live(s,monkeypatch)
    s.provider.v1.payouts.create=lambda body,*,options: {
        'id':'po_live_23456789','currency':'mxn','amount':body['amount'],
        'status':'pending','livemode':True,'destination':bank,
        'metadata':body['metadata']}
    original=_request(s,1000,'original_bank_pin_1234')
    monkeypatch.setattr(settings,'withdrawals_approved_bank_destinations',[
        f'{s.rest.payout_account_ref}:ba_ANOTHERBANK987654'])
    with pytest.raises(HTTPException) as exc: w.request_withdrawal('restaurant',s.rest.id,
        w.RequestPayout(amount_cents=1000,totp='000000'),'original_bank_pin_1234',s.owner,s.db)
    assert exc.value.status_code==409


def test_live_webhook_cannot_mark_paid_if_destination_different(scenario,monkeypatch):
    s=scenario
    bank=_live(s,monkeypatch)
    s.db.add(models.WithdrawalRequest(payee_type='restaurant', payee_id=s.rest.id,
        requested_by=s.owner.id,connected_account_id=s.rest.payout_account_ref,
        bank_destination_id=bank,client_key='signed_bank_pin_check_123', amount_cents=1000,
        otp_step=1,status='submitted'))
    s.db.commit()
    # Provider confirms paid status but returns a foreign bank destination.
    import json, asyncio, sys
    from types import SimpleNamespace
    from starlette.requests import Request
    row=s.db.scalar(select(models.WithdrawalRequest))
    class Webhook:
        @staticmethod
        def construct_event(raw,sig,secret,tolerance): return json.loads(raw)
    monkeypatch.setitem(sys.modules,'stripe',SimpleNamespace(Webhook=Webhook))
    s.provider.v1.payouts.retrieve=lambda payout_id,*,options: {
        'id':payout_id,'amount':1000,'currency':'mxn','status':'paid','livemode':True,
        'destination':'ba_WRONG000000000','automatic':False,
        'metadata':{'tala_withdrawal_id':str(row.id),'payee_type':'restaurant','payee_id':str(s.rest.id)}}
    body=json.dumps({'id':'evt_wrong_bank_real_1234','account':s.rest.payout_account_ref,
                     'livemode':True,'type':'payout.paid',
                     'data':{'object':{'id':'po_bank_target_12345','amount':1000,'currency':'mxn',
                                       'metadata':{'tala_withdrawal_id':str(row.id)}}}}).encode()
    async def receive():return {'type':'http.request','body':body,'more_body':False}
    scope={'type':'http','method':'POST','path':'/api/v1/withdrawals/stripe-connect/webhook',
           'headers':[(b'stripe-signature',b'mock-live-signature')]}
    with pytest.raises(HTTPException) as exc:
        asyncio.run(w.connect_webhook(Request(scope,receive),s.db))
    assert exc.value.status_code==409
    row=s.db.scalar(select(models.WithdrawalRequest))
    assert row.status=='submitted'


def test_connect_webhook_rejects_oversized_signed_event(scenario,monkeypatch):
    # Test cap via an already-signature-validated event while the byte body
    # itself is oversized. This prevents indefinite event retention in DB.
    import asyncio, json, sys
    from types import SimpleNamespace
    from starlette.requests import Request
    s=scenario
    body=json.dumps({'id':'evt_big_123','account':s.rest.payout_account_ref,
                     'type':'noop','livemode':False,'metadata': 'x'*(1024*1024)}).encode()
    class Webhook:
        @staticmethod
        def construct_event(*args,**kwargs): return json.loads(args[0])
    monkeypatch.setitem(sys.modules,'stripe',SimpleNamespace(Webhook=Webhook))
    async def receive(): return {'type':'http.request','body':body,'more_body':False}
    scope={'type':'http','method':'POST','path':'/api/v1/withdrawals/stripe-connect/webhook', 'headers':[(b'stripe-signature',b'signed')]}
    with pytest.raises(HTTPException) as exc: asyncio.run(w.connect_webhook(Request(scope,receive),s.db))
    assert exc.value.status_code==413


def test_stripe_verified_payout_history_paginates_over_100(scenario):
    s=scenario
    known=[f'po_historical_{i:05d}' for i in range(110)]
    for i,pid in enumerate(known):
        s.db.add(models.WithdrawalRequest(payee_type='restaurant',payee_id=s.rest.id,
            requested_by=s.owner.id,connected_account_id=s.rest.payout_account_ref,
            client_key=f'prior_history_{i:05d}_key', amount_cents=100,
            otp_step=i+1,status='paid',stripe_payout_id=pid))
    s.db.commit()
    pages=[]
    def list_payouts(params,*,options):
        cursor=params.get('starting_after')
        if cursor:
            start=known.index(cursor)+1
        else:start=0
        page=known[start:start+100]
        pages.append(page)
        return {'data':[{'id':pid,'automatic':False} for pid in page],
                'has_more':start+100<len(known)}
    s.provider.v1.payouts.list=list_payouts
    available=w._provider(s.provider,s.rest.payout_account_ref,local_known=set(known),transfers=[])
    assert available==12000 and len(pages)==2


def test_stripe_payout_history_duplicate_cursor_fails_closed(scenario):
    s=scenario
    known=['po_older_history_123456']
    s.db.add(models.WithdrawalRequest(payee_type='restaurant',payee_id=s.rest.id,
        requested_by=s.owner.id,connected_account_id=s.rest.payout_account_ref,
        client_key='historical_duplicate_cursor_key',amount_cents=100,otp_step=2,
        status='paid',stripe_payout_id=known[0]))
    s.db.commit()
    s.provider.v1.payouts.list=lambda *args,**kwargs:{'data':[{'id':known[0]}], 'has_more':True}
    with pytest.raises(HTTPException) as exc: w._provider(s.provider,s.rest.payout_account_ref,local_known=set(known),transfers=[])
    assert exc.value.status_code==409
