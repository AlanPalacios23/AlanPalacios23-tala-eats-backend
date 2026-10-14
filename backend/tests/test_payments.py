from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.main import app


def login(client, email, password):
    r=client.post('/api/v1/auth/login',json={'email':email,'password':password})
    assert r.status_code==200,r.text
    return {'Authorization':f"Bearer {r.json()['access_token']}"}


class FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload=payload; self.status_code=status_code; self.ok=status_code<400
    def json(self): return self._payload


def test_mercadopago_checkout_webhook_and_refund(monkeypatch):
    from app.config import settings
    settings.mercado_pago_access_token='APP_USR_TEST'
    settings.payment_provider='mercadopago'
    with TestClient(app) as c:
        customer=login(c,'cliente@talaeats.mx','Cliente123!')
        item=c.get('/api/v1/restaurants/1').json()['menu_items'][0]
        created=c.post('/api/v1/orders',headers=customer,json={
            'restaurant_id':1,'address':'Centro, Tala','payment_method':'mercadopago','distance_km':1.0,
            'items':[{'menu_item_id':item['id'],'quantity':1}]
        })
        assert created.status_code==201,created.text
        oid=created.json()['id']

        monkeypatch.setattr('app.routes.payments.http_post',lambda *a,**k:FakeResponse({'id':'pref-1','init_point':'https://mercadopago.example/checkout'},201))
        checkout=c.post(f'/api/v1/payments/mercadopago/orders/{oid}/checkout',headers=customer)
        assert checkout.status_code==200,checkout.text
        assert checkout.json()['checkout_url'].startswith('https://')
        assert checkout.json()['expires_at']

        monkeypatch.setattr('app.routes.payments.http_get',lambda *a,**k:FakeResponse({
            'id':'pay-123','external_reference':str(oid),'transaction_amount':float(created.json()['total']),'status':'approved'
        }))
        wh=c.post('/api/v1/payments/mercadopago/webhook?type=payment&data.id=pay-123',json={
            'id':'notification-1','date_created':'2026-08-21T17:00:00Z','action':'payment.updated','type':'payment','data':{'id':'pay-123'}
        })
        assert wh.status_code==200,wh.text
        assert c.get(f'/api/v1/orders/{oid}',headers=customer).json()['payment_status']=='paid'

        admin=login(c,'admin@talaeats.mx','Admin123!')
        monkeypatch.setattr('app.routes.payments.http_post',lambda *a,**k:FakeResponse({'id':'refund-1','payment_id':'pay-123'},201))
        refund=c.post(f'/api/v1/payments/mercadopago/orders/{oid}/refund',headers=admin)
        assert refund.status_code==200,refund.text
        assert refund.json()['payment_status']=='refunded'
        detail=c.get(f'/api/v1/orders/{oid}',headers=customer).json()
        assert detail['status']=='cancelled' and detail['payment_status']=='refunded'
