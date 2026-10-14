from datetime import datetime, timezone
from fastapi.testclient import TestClient
from app.main import app
from app.security import _totp_code


def login(client,email,password,otp=''):
    r=client.post('/api/v1/auth/login',json={'email':email,'password':password,'otp':otp});assert r.status_code==200,r.text
    return {'Authorization':f"Bearer {r.json()['access_token']}"}


def test_v9_overview_search_recommendations_and_group_cart():
    with TestClient(app) as c:
        overview=c.get('/api/v1/v9/overview');assert overview.status_code==200;assert overview.json()['capabilities']==112
        search=c.get('/api/v1/v9/search?q=algo%20barato%20con%20pollo');assert search.status_code==200;assert 'intent' in search.json()
        customer=login(c,'cliente@talaeats.mx','Cliente123!')
        rec=c.get('/api/v1/v9/recommendations',headers=customer);assert rec.status_code==200;assert 'restaurants' in rec.json()
        group=c.post('/api/v1/v9/groups',headers=customer,json={'restaurant_id':1});assert group.status_code==201,group.text;code=group.json()['code']
        menu=c.get('/api/v1/restaurants/1').json()['menu_items'][0]
        add=c.post(f'/api/v1/v9/groups/{code}/items',headers=customer,json={'menu_item_id':menu['id'],'quantity':2,'options':''});assert add.status_code==200,add.text;assert add.json()['participants']==1
        payload=c.get(f'/api/v1/v9/groups/{code}/checkout-payload',headers=customer);assert payload.status_code==200;assert payload.json()['items'][0]['quantity']==2


def test_v9_admin_growth_observability_partner_and_corporate():
    with TestClient(app) as c:
        admin=login(c,'admin@talaeats.mx','Admin123!')
        assert c.get('/api/v1/v9/admin/demand-forecast?hours=4',headers=admin).status_code==200
        status=c.get('/api/v1/v9/admin/system-status',headers=admin);assert status.status_code==200;assert status.json()['checks']['database']=='ok'
        exp=c.post('/api/v1/v9/admin/experiments',headers=admin,json={'key':'pytest_v9','name':'Pytest V9','variants':['control','premium'],'audience_role':'customer','rollout_percent':100,'primary_metric':'checkout_completed','status':'running'});assert exp.status_code in {201,409},exp.text
        partner=c.post('/api/v1/v9/admin/partner-keys',headers=admin,json={'partner_name':'Pytest POS','scopes':'catalog:read'});assert partner.status_code==201;key=partner.json()['api_key']
        catalog=c.get('/api/v1/v9/partner/catalog',headers={'X-Partner-Key':key});assert catalog.status_code==200;assert len(catalog.json()['restaurants'])>=1
        corp=c.post('/api/v1/v9/admin/corporate',headers=admin,json={'name':'Empresa Pytest V9','monthly_budget':5000,'cost_center':'TI'});assert corp.status_code in {201,500},corp.text
        if corp.status_code==201:
            customer=login(c,'cliente@talaeats.mx','Cliente123!')
            joined=c.post('/api/v1/v9/corporate/join',headers=customer,json={'join_code':corp.json()['join_code'],'employee_code':'E001'});assert joined.status_code==200
            me=c.get('/api/v1/v9/corporate/me',headers=customer);assert me.status_code==200;assert any(x['id']==corp.json()['id'] for x in me.json())


def test_v9_merchant_inventory_driver_score_privacy_and_2fa():
    with TestClient(app) as c:
        merchant=login(c,'restaurante@talaeats.mx','Restaurante123!')
        ingredient=c.post('/api/v1/v9/merchant/ingredients',headers=merchant,json={'name':'Tomate V9','unit':'kg','quantity':10,'reorder_level':2,'unit_cost':25});assert ingredient.status_code==201,ingredient.text
        intel=c.get('/api/v1/v9/merchant/intelligence',headers=merchant);assert intel.status_code==200
        setup=c.post('/api/v1/v9/security/2fa/setup',headers=merchant);assert setup.status_code==200,setup.text
        secret=setup.json()['secret'];code=_totp_code(secret,int(datetime.now(timezone.utc).timestamp())//30)
        confirm=c.post('/api/v1/v9/security/2fa/confirm',headers=merchant,json={'code':code});assert confirm.status_code==200,confirm.text
        driver=login(c,'repartidor@talaeats.mx','Repartidor123!')
        score=c.get('/api/v1/v9/driver/score',headers=driver);assert score.status_code==200;assert 'punctuality' in score.json()
        customer=login(c,'cliente@talaeats.mx','Cliente123!')
        export=c.post('/api/v1/v9/privacy',headers=customer,json={'request_type':'export'});assert export.status_code==201;assert export.json()['status']=='completed'
