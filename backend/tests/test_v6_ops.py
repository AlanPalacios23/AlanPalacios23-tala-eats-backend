from fastapi.testclient import TestClient
from app.main import app


def login(client,email,password):
    r=client.post('/api/v1/auth/login',json={'email':email,'password':password});assert r.status_code==200,r.text
    return {'Authorization':f"Bearer {r.json()['access_token']}"}


def test_command_center_finance_flags_zones_and_simulation():
    with TestClient(app) as c:
        admin=login(c,'admin@talaeats.mx','Admin123!')
        cc=c.get('/api/v1/operations/admin/command-center',headers=admin);assert cc.status_code==200,cc.text;assert 'live' in cc.json() and 'today' in cc.json()
        fin=c.get('/api/v1/operations/admin/finance/summary',headers=admin);assert fin.status_code==200,fin.text;assert 'contribution_margin' in fin.json()
        zones=c.get('/api/v1/operations/zones');assert zones.status_code==200,zones.text;assert len(zones.json())>=1
        covered=c.get('/api/v1/operations/coverage?lat=20.6534&lng=-103.7040');assert covered.status_code==200;assert covered.json()['covered'] is True
        flag=c.put('/api/v1/operations/admin/flags',headers=admin,json={'key':'pytest.v6','description':'test','enabled':True,'rollout_percent':50,'audience_role':'customer'});assert flag.status_code==200,flag.text
        setting=c.put('/api/v1/operations/admin/settings',headers=admin,json={'key':'service_fee_min','value':'6.00','value_type':'decimal','description':'pytest'});assert setting.status_code==200,setting.text
        sim=c.post('/api/v1/operations/admin/simulations',headers=admin,json={'scenario':'happy_path'});assert sim.status_code==201,sim.text
        sid=sim.json()['id'];done=c.post(f'/api/v1/operations/admin/simulations/{sid}/run-all',headers=admin);assert done.status_code==200,done.text;assert done.json()['status']=='completed';assert done.json()['current_step']=='settled'


def test_onboarding_dispute_referral_and_financial_fields():
    with TestClient(app) as c:
        # Fresh customer can apply to become a driver without bypassing approval.
        email='partner.v6@example.com';reg=c.post('/api/v1/auth/register',json={'name':'Partner V6','email':email,'password':'Partner123!'});assert reg.status_code in {201,409},reg.text
        partner=login(c,email,'Partner123!')
        application=c.post('/api/v1/operations/onboarding',headers=partner,json={'entity_type':'driver','vehicle':'Motocicleta','documents':['ine://demo'],'payout_account_ref':'provider-token-demo'});assert application.status_code==201,application.text;aid=application.json()['id']
        admin=login(c,'admin@talaeats.mx','Admin123!')
        approve=c.patch(f'/api/v1/operations/admin/onboarding/{aid}',headers=admin,json={'status':'approved','notes':'pytest'});assert approve.status_code==200,approve.text

        customer=login(c,'cliente@talaeats.mx','Cliente123!')
        restaurant=c.get('/api/v1/restaurants/1').json();item=restaurant['menu_items'][0]
        order=c.post('/api/v1/orders',headers=customer,json={'restaurant_id':1,'address':'Centro, Tala, Jalisco','payment_method':'cash','distance_km':1.0,'items':[{'menu_item_id':item['id'],'quantity':1}]});assert order.status_code==201,order.text
        data=order.json();assert float(data['service_fee'])>=0;assert float(data['platform_revenue'])>=0;assert 'contribution_margin' in data
        preview=c.get(f"/api/v1/orders/{data['id']}/cancellation-preview",headers=customer);assert preview.status_code==200,preview.text;assert preview.json()['cancellable'] is True
        dispute=c.post('/api/v1/operations/disputes',headers=customer,json={'order_id':data['id'],'category':'pedido','description':'Prueba de disputa V6'});assert dispute.status_code==201,dispute.text
        did=dispute.json()['id'];resolved=c.patch(f'/api/v1/operations/admin/disputes/{did}',headers=admin,json={'status':'resolved','resolution':'Crédito de cortesía','refund_amount':5});assert resolved.status_code==200,resolved.text;assert float(resolved.json()['refund_amount'])==5


def test_private_onboarding_document_upload():
    with TestClient(app) as c:
        customer=login(c,'cliente@talaeats.mx','Cliente123!')
        uploaded=c.post('/api/v1/uploads/onboarding-document',headers=customer,files={'file':('ine-demo.pdf',b'%PDF-1.4\n% demo','application/pdf')})
        assert uploaded.status_code==200,uploaded.text
        url=uploaded.json()['url']
        application=c.post('/api/v1/operations/onboarding',headers=customer,json={'entity_type':'driver','vehicle':'Motocicleta','documents':[url],'payout_account_ref':'pytest-ref'})
        assert application.status_code in {201,409},application.text
        if application.status_code==201:
            fetched=c.get(url,headers=customer)
            assert fetched.status_code==200,fetched.text
            assert fetched.headers['content-type'].startswith('application/pdf')
