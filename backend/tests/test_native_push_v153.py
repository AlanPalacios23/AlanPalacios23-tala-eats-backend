"""Native push security/queue tests; provider mocked, no Firebase secrets/calls."""
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from sqlalchemy import select
from app import models
from app.config import settings
from app.db import SessionLocal
from app.main import app
from app import native_push


def enable(monkeypatch):
    monkeypatch.setattr(settings, "native_push_enabled", True)
    monkeypatch.setattr(settings, "fcm_project_id", "test-local")
    monkeypatch.setattr(settings, "fcm_credentials_file", "mock-does-not-exist.json")
    monkeypatch.setattr(settings, "fcm_token_encryption_key", Fernet.generate_key().decode())


def auth(client, email, password):
    r=client.post('/api/v1/auth/login', json={"email":email,"password":password})
    assert r.status_code==200, r.text
    return {"Authorization": "Bearer " + r.json()["access_token"]}


def register(client,headers,application="customer",token="my_fcm_test_token_at_least_20_chars",consent=False):
    return client.put('/api/v1/mobile-push/devices', headers=headers, json={
        "token":token,"device_id":"dev-01-android","application":application,"platform":"android",
        "marketing_opt_in": consent,
    })


def test_disabled_default():
    with TestClient(app) as c:
        assert c.get('/api/v1/mobile-push/config').json()['enabled'] is False
        h=auth(c,'cliente@talaeats.mx','Cliente123!')
        assert register(c,h).status_code==503


def test_public_config_project_identity_never_leaks_credentials(monkeypatch):
    enable(monkeypatch)
    with TestClient(app) as c:
        config = c.get('/api/v1/mobile-push/config').json()
        assert config['enabled'] is True
        assert config['provider'] == 'fcm'
        assert config['project_id'] == 'test-local'
        assert 'credentials' not in str(config).lower()
        assert 'encryption' not in str(config).lower()
    monkeypatch.setattr(settings, 'native_push_enabled', False)
    with TestClient(app) as c:
        config = c.get('/api/v1/mobile-push/config').json()
        assert config['enabled'] is False
        assert config['project_id'] == ''


def test_register_role_bound_and_encrypted(monkeypatch):
    enable(monkeypatch)
    with TestClient(app) as c:
        h=auth(c,'cliente@talaeats.mx','Cliente123!')
        assert register(c,h,application='driver').status_code==403
        r=register(c,h)
        assert r.status_code==200, r.text
        assert r.json()['marketing_opt_in'] is False
        assert register(c,h).status_code==200
        with SessionLocal() as db:
            devs=db.scalars(select(models.MobilePushDevice)).all()
            assert len(devs)==1
            assert 'my_fcm_test_token_' not in devs[0].encrypted_token
            assert devs[0].token_hash == native_push._token_hash('my_fcm_test_token_at_least_20_chars')
        assert c.put('/api/v1/mobile-push/devices/dev-01-android/preferences',headers=h,json={'marketing_opt_in':True}).status_code==200
        assert c.delete('/api/v1/mobile-push/devices/dev-01-android',headers=h).status_code==200
        with SessionLocal() as db:
            assert db.scalar(select(models.MobilePushDevice)).active is False


def test_atomic_fanout_retries_and_success(monkeypatch):
    enable(monkeypatch)
    with TestClient(app) as c:
        h=auth(c,'cliente@talaeats.mx','Cliente123!')
        assert register(c,h).status_code==200
        with SessionLocal() as db:
            user=db.scalar(select(models.User).where(models.User.email=='cliente@talaeats.mx'))
            db.add(models.Notification(user_id=user.id,kind='order',title='Pedido confirmado', message='Pedido #123 en camino'))
            db.commit()
            jobs=db.scalars(select(models.MobilePushDelivery)).all()
            assert len(jobs)==1 and jobs[0].state=='queued'
        calls=[]
        monkeypatch.setattr(native_push,'_send_fcm',lambda token,**kw:(calls.append(kw) or native_push.SendResult(True)))
        sent,failed=native_push.deliver_native_push()
        assert (sent,failed)==(1,0)
        assert calls[0]['order_id']=='123'
        assert native_push.deliver_native_push()==(0,0)
        with SessionLocal() as db:
            job=db.scalar(select(models.MobilePushDelivery))
            assert job.state=='sent' and job.attempts==1


def test_marketing_requires_explicit_device_consent(monkeypatch):
    enable(monkeypatch)
    with TestClient(app) as c:
        h=auth(c,'cliente@talaeats.mx','Cliente123!')
        assert register(c,h).status_code==200
        with SessionLocal() as db:
            user=db.scalar(select(models.User).where(models.User.email=='cliente@talaeats.mx'))
            db.add(models.Notification(user_id=user.id,kind='growth',title='Nueva oferta',message='Prueba promocional'))
            db.commit()
        monkeypatch.setattr(native_push,'_send_fcm',lambda *a,**kw: (_ for _ in ()).throw(AssertionError('no marketing push')))
        assert native_push.deliver_native_push()==(0,0)
        with SessionLocal() as db:
            assert db.scalar(select(models.MobilePushDelivery)).state=='suppressed'


def test_transient_fcm_failure_is_retryable(monkeypatch):
    enable(monkeypatch)
    with TestClient(app) as c:
        h=auth(c,'cliente@talaeats.mx','Cliente123!')
        assert register(c,h).status_code==200
        with SessionLocal() as db:
            user=db.scalar(select(models.User).where(models.User.email=='cliente@talaeats.mx'))
            db.add(models.Notification(user_id=user.id,kind='order',title='Estado',message='Tu pedido #55'))
            db.commit()
        monkeypatch.setattr(native_push,'_send_fcm',lambda *a,**kw:native_push.SendResult(False, reason='temporary'))
        assert native_push.deliver_native_push()==(0,1)
        with SessionLocal() as db:
            job=db.scalar(select(models.MobilePushDelivery))
            assert job.state=='queued' and job.attempts==1 and job.next_attempt_at is not None


def test_unauthenticated_and_cross_user_device_control(monkeypatch):
    enable(monkeypatch)
    with TestClient(app) as c:
        assert c.put('/api/v1/mobile-push/devices', json={}).status_code in (401,403,422)
        h=auth(c,'cliente@talaeats.mx','Cliente123!')
        assert register(c,h).status_code==200
        driver=auth(c,'repartidor@talaeats.mx','Repartidor123!')
        assert c.put('/api/v1/mobile-push/devices/dev-01-android/preferences',headers=driver,json={'marketing_opt_in':True}).status_code==404
        assert c.delete('/api/v1/mobile-push/devices/dev-01-android',headers=driver).status_code==200
        with SessionLocal() as db:
            assert db.scalar(select(models.MobilePushDevice)).active is True
