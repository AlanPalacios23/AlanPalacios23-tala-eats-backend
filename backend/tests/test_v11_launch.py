from fastapi.testclient import TestClient
from app.main import app
from app.db import SessionLocal
from app import models


def login(c,email,password):
    r=c.post('/api/v1/auth/login',json={'email':email,'password':password});assert r.status_code==200,r.text
    return {'Authorization':f"Bearer {r.json()['access_token']}"}


def test_v11_overview_contract_privacy_and_command_center():
    with TestClient(app) as c:
        overview=c.get('/api/v1/v11/overview');assert overview.status_code==200;assert overview.json()['capabilities']==150
        readiness=c.get('/api/v1/v11/launch-readiness');assert readiness.status_code==200;assert readiness.json()['core_ready'] is True
        mobile=c.get('/api/v1/v11/mobile/contract');assert mobile.status_code==200;assert mobile.json()['contract_version']=='11.0'
        customer=login(c,'cliente@talaeats.mx','Cliente123!')
        prefs=c.get('/api/v1/v11/privacy/preferences',headers=customer);assert prefs.status_code==200
        changed=c.put('/api/v1/v11/privacy/preferences',headers=customer,json={'marketing_opt_in':False,'analytics_opt_in':False,'personalization_opt_in':True});assert changed.status_code==200;assert changed.json()['analytics_opt_in'] is False
        cohort=c.get('/api/v1/v11/release-cohort',headers=customer);assert cohort.status_code==200;assert 0<=cohort.json()['bucket']<=99
        admin=login(c,'admin@talaeats.mx','Admin123!')
        cc=c.get('/api/v1/v11/admin/command-center',headers=admin);assert cc.status_code==200,cc.text;assert 'integrations' in cc.json();assert 'runtime' in cc.json()
        canary=c.put('/api/v1/v11/admin/canary',headers=admin,json={'percent':5});assert canary.status_code==200;assert canary.json()['canary_percent']==5


def test_v11_push_kds_live_and_partial_cash_refund():
    with TestClient(app) as c:
        customer=login(c,'cliente@talaeats.mx','Cliente123!')
        restaurant=c.get('/api/v1/restaurants/1').json();item=restaurant['menu_items'][0]
        order=c.post('/api/v1/orders',headers=customer,json={'restaurant_id':1,'address':'Centro de Tala','payment_method':'cash','items':[{'menu_item_id':item['id'],'quantity':1}]} );assert order.status_code==201,order.text;oid=order.json()['id']
        live=c.get(f'/api/v1/v11/orders/{oid}/live',headers=customer);assert live.status_code==200;assert live.json()['order']['id']==oid
        sub=c.post('/api/v1/v11/push/subscriptions',headers=customer,json={'endpoint':'https://push.example.test/subscription/1234567890','p256dh':'abc','auth':'def','platform':'web','device_label':'Test browser'});assert sub.status_code==201,sub.text
        owner=login(c,'restaurante@talaeats.mx','Restaurante123!')
        kds=c.get('/api/v1/v11/merchant/kds-pro',headers=owner);assert kds.status_code==200, kds.text
        bump=c.post(f'/api/v1/v11/merchant/orders/{oid}/bump',headers=owner,json={'action':'confirm','station':'general'});assert bump.status_code==200;assert bump.json()['status']=='confirmed'
        admin=login(c,'admin@talaeats.mx','Admin123!')
        refund=c.post(f'/api/v1/v11/admin/orders/{oid}/partial-refund',headers=admin,json={'amount':'1.00','reason':'Ajuste QA','idempotency_key':f'qa-refund-{oid}-0001'});assert refund.status_code==200,refund.text;assert refund.json()['status']=='completed'
        again=c.post(f'/api/v1/v11/admin/orders/{oid}/partial-refund',headers=admin,json={'amount':'1.00','reason':'Ajuste QA','idempotency_key':f'qa-refund-{oid}-0001'});assert again.status_code==200;assert again.json()['id']==refund.json()['id']


def test_v11_substitution_lower_price_resolution():
    with TestClient(app) as c:
        customer=login(c,'cliente@talaeats.mx','Cliente123!')
        menu=c.get('/api/v1/restaurants/1').json()['menu_items']
        assert len(menu)>=2
        expensive=max(menu,key=lambda x:float(x['price'])); cheaper=min(menu,key=lambda x:float(x['price']))
        if float(cheaper['price'])>float(expensive['price']): cheaper=expensive
        order=c.post('/api/v1/orders',headers=customer,json={'restaurant_id':1,'address':'Centro Tala','payment_method':'cash','items':[{'menu_item_id':expensive['id'],'quantity':1}]});assert order.status_code==201,order.text;oid=order.json()['id'];line=order.json()['items'][0]
        owner=login(c,'restaurante@talaeats.mx','Restaurante123!')
        req=c.post(f'/api/v1/v11/merchant/orders/{oid}/substitutions',headers=owner,json={'order_item_id':line['id'],'replacement_menu_item_id':cheaper['id'],'issue_type':'unavailable','message':'Proponemos reemplazo'});assert req.status_code==201,req.text;sid=req.json()['id']
        response=c.post(f'/api/v1/v11/orders/{oid}/substitutions/{sid}/respond',headers=customer,json={'action':'accept'});assert response.status_code==200,response.text;assert response.json()['status']=='resolved'
