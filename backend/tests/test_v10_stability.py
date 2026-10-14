from fastapi.testclient import TestClient
from app.main import app


def login(client,email,password):
    r=client.post('/api/v1/auth/login',json={'email':email,'password':password,'otp':''});assert r.status_code==200,r.text
    return {'Authorization':f"Bearer {r.json()['access_token']}"}


def test_v10_overview_and_readiness():
    with TestClient(app) as c:
        o=c.get('/api/v1/v10/overview');assert o.status_code==200,o.text
        assert o.json()['capabilities']==122
        assert o.json()['stability']['frontend_error_boundary'] is True
        ready=c.get('/api/v1/ready');assert ready.status_code==200,ready.text
        assert ready.json()['database'] is True


def test_v10_admin_stability_center():
    with TestClient(app) as c:
        admin=login(c,'admin@talaeats.mx','Admin123!')
        r=c.get('/api/v1/v10/admin/stability',headers=admin);assert r.status_code==200,r.text
        body=r.json();assert body['dependencies']['database']=='ok'
        assert 'p95_ms' in body['traffic']
        customer=login(c,'cliente@talaeats.mx','Cliente123!')
        denied=c.get('/api/v1/v10/admin/stability',headers=customer);assert denied.status_code==403
