from fastapi.testclient import TestClient
from app.main import app


def login(client,email,password):
    r=client.post('/api/v1/auth/login',json={'email':email,'password':password});assert r.status_code==200,r.text
    return {'Authorization':f"Bearer {r.json()['access_token']}"}


def test_legacy_multirole_flow_remains_compatible():
    with TestClient(app) as c:
        health=c.get('/api/v1/health');assert health.status_code==200;assert health.json()['version']=='1.6.2-fair-pricing';assert health.json()['features']==170
        feature_data=c.get('/api/v1/platform/features').json();assert feature_data['feature_count']==112;assert len(feature_data['features'])==112

        customer=login(c,'cliente@talaeats.mx','Cliente123!')
        loyalty=c.get('/api/v1/platform/loyalty',headers=customer);assert loyalty.status_code==200;assert loyalty.json()['plus_member'] is True
        gift=c.post('/api/v1/platform/gift-cards/redeem',headers=customer,json={'code':'REGALO100'});assert gift.status_code==200;assert float(gift.json()['wallet_balance'])>=100
        fav=c.post('/api/v1/platform/favorites/1',headers=customer);assert fav.status_code==200;assert fav.json()['favorite'] is True
        restaurant=c.get('/api/v1/restaurants/1');assert restaurant.status_code==200;item=restaurant.json()['menu_items'][0]
        order=c.post('/api/v1/orders',headers=customer,json={
            'restaurant_id':1,'address':'Centro, Tala, Jalisco','notes':'Prueba V3','payment_method':'cash','tip':20,
            'order_type':'delivery','coupon_code':'TALA20','distance_km':2.0,'group_code':'TESTTEAM','invoice_requested':True,'invoice_tax_id':'XAXX010101000',
            'items':[{'menu_item_id':item['id'],'quantity':1,'options':'Sin cebolla'}]
        });assert order.status_code==201,order.text;o=order.json();assert float(o['discount'])>0;assert float(o['platform_commission'])>=0;oid=o['id']

        owner=login(c,'restaurante@talaeats.mx','Restaurante123!')
        for status in ['confirmed','preparing','ready']:
            r=c.patch(f'/api/v1/owner/orders/{oid}/status',headers=owner,json={'status':status});assert r.status_code==200,r.text
        assigned=c.get(f'/api/v1/orders/{oid}',headers=customer).json();assert assigned['status']=='assigned';assert assigned['driver_info'] is not None

        driver=login(c,'repartidor@talaeats.mx','Repartidor123!')
        picked=c.patch(f'/api/v1/driver/orders/{oid}/status',headers=driver,json={'status':'picked_up'});assert picked.status_code==200,picked.text
        route=c.patch(f'/api/v1/driver/orders/{oid}/status',headers=driver,json={'status':'on_the_way'});assert route.status_code==200
        complete=c.post(f'/api/v1/driver/orders/{oid}/complete',headers=driver,json={'pin':o['delivery_pin'],'photo_url':'demo://proof','lat':20.65,'lng':-103.70});assert complete.status_code==200,complete.text;assert complete.json()['status']=='delivered'

        review=c.post('/api/v1/platform/reviews',headers=customer,json={'order_id':oid,'restaurant_rating':5,'driver_rating':5,'comment':'Excelente'});assert review.status_code==201,review.text
        ticket=c.post('/api/v1/platform/support',headers=customer,json={'order_id':oid,'category':'Pedido','message':'Ticket demo de validación'});assert ticket.status_code==201
        msg=c.post(f'/api/v1/platform/orders/{oid}/chat',headers=customer,json={'message':'Gracias por la entrega'});assert msg.status_code==201

        admin=login(c,'admin@talaeats.mx','Admin123!');stats=c.get('/api/v1/admin/stats',headers=admin);assert stats.status_code==200;assert stats.json()['drivers']>=1;assert stats.json()['support_open']>=1
        admin_orders=c.get('/api/v1/admin/orders',headers=admin);assert admin_orders.status_code==200;assert any(x['id']==oid for x in admin_orders.json())

        # Production safety: backend calculates coverage from coordinates instead of trusting distance_km.
        too_far=c.post('/api/v1/orders',headers=customer,json={
            'restaurant_id':1,'address':'Ubicación fuera de cobertura','payment_method':'cash','distance_km':0.1,
            'delivery_lat':21.0,'delivery_lng':-104.0,'items':[{'menu_item_id':item['id'],'quantity':1}]
        });assert too_far.status_code==400,too_far.text

        # Mercado Pago orders cannot be prepared before a signed webhook marks payment as paid.
        mp=c.post('/api/v1/orders',headers=customer,json={
            'restaurant_id':1,'address':'Centro, Tala, Jalisco','payment_method':'mercadopago','distance_km':1.0,
            'items':[{'menu_item_id':item['id'],'quantity':1}]
        });assert mp.status_code==201,mp.text;mpid=mp.json()['id']
        blocked=c.patch(f'/api/v1/owner/orders/{mpid}/status',headers=owner,json={'status':'confirmed'});assert blocked.status_code==409,blocked.text
        from app.db import SessionLocal
        from app import models
        with SessionLocal() as db:
            row=db.get(models.Order,mpid);row.payment_status='paid';row.payment_provider_id='payment-test-123';db.commit()
        allowed=c.patch(f'/api/v1/owner/orders/{mpid}/status',headers=owner,json={'status':'confirmed'});assert allowed.status_code==200,allowed.text
        paid_cancel=c.post(f'/api/v1/orders/{mpid}/cancel',headers=customer);assert paid_cancel.status_code==409,paid_cancel.text
