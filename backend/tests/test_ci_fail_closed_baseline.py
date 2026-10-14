"""Configuration-only fail-closed tests: no Stripe calls, no live secrets."""
import pytest
from app.config import settings


def test_production_rejects_development_defaults(monkeypatch):
    monkeypatch.setattr(settings, 'environment', 'production')
    monkeypatch.setattr(settings, 'jwt_secret', 'CHANGE_ME_IN_PRODUCTION')
    monkeypatch.setattr(settings, 'database_url', 'sqlite://')
    monkeypatch.setattr(settings, 'redis_url', '')
    with pytest.raises(RuntimeError) as exc:
        settings.validate_production()
    message = str(exc.value)
    assert 'JWT_SECRET' in message
    assert 'DATABASE_URL' in message
    assert 'REDIS_URL' in message


def test_production_rejects_wildcard_domains_and_http(monkeypatch):
    monkeypatch.setattr(settings, 'environment', 'production')
    monkeypatch.setattr(settings, 'allowed_hosts', ['*'])
    monkeypatch.setattr(settings, 'cors_origins', ['*'])
    monkeypatch.setattr(settings, 'public_base_url', 'http://example.test')
    monkeypatch.setattr(settings, 'frontend_url', 'http://example.test')
    with pytest.raises(RuntimeError) as exc:
        settings.validate_production()
    message = str(exc.value)
    assert 'ALLOWED_HOSTS' in message
    assert 'CORS_ORIGINS' in message
    assert 'PUBLIC_BASE_URL' in message
    assert 'FRONTEND_URL' in message


def test_live_withdrawal_requires_second_switch_and_bank_pin(monkeypatch):
    monkeypatch.setattr(settings, 'environment', 'production')
    monkeypatch.setattr(settings, 'withdrawals_execution_enabled', True)
    monkeypatch.setattr(settings, 'withdrawals_preview_enabled', True)
    monkeypatch.setattr(settings, 'stripe_enabled', True)
    monkeypatch.setattr(settings, 'stripe_connect_enabled', True)
    monkeypatch.setattr(settings, 'stripe_secret_key', 'sk_live_' + 'QAONLYNOTREAL')
    monkeypatch.setattr(settings, 'stripe_connect_webhook_secret', 'dummy-ci-webhook-no-network')
    monkeypatch.setattr(settings, 'withdrawals_live_enabled', False)
    monkeypatch.setattr(settings, 'withdrawals_approved_accounts', [])
    monkeypatch.setattr(settings, 'withdrawals_approved_bank_destinations', [])
    with pytest.raises(RuntimeError) as exc:
        settings.validate_production()
    message = str(exc.value)
    assert 'WITHDRAWALS_LIVE_ENABLED' in message
    assert 'WITHDRAWALS_APPROVED_ACCOUNTS' in message
    assert 'WITHDRAWALS_APPROVED_BANK_DESTINATIONS' in message


def test_live_bank_destination_must_belong_to_approved_account(monkeypatch):
    monkeypatch.setattr(settings, 'environment', 'production')
    monkeypatch.setattr(settings, 'withdrawals_execution_enabled', True)
    monkeypatch.setattr(settings, 'withdrawals_preview_enabled', True)
    monkeypatch.setattr(settings, 'stripe_enabled', True)
    monkeypatch.setattr(settings, 'stripe_connect_enabled', True)
    monkeypatch.setattr(settings, 'stripe_secret_key', 'sk_live_' + 'QAONLYNOTREAL')
    monkeypatch.setattr(settings, 'stripe_connect_webhook_secret', 'dummy-ci-webhook-no-network')
    monkeypatch.setattr(settings, 'withdrawals_live_enabled', True)
    monkeypatch.setattr(settings, 'withdrawals_approved_accounts', ['acct_1234567890'])
    monkeypatch.setattr(settings, 'withdrawals_approved_bank_destinations', ['acct_9999999999:ba_1234567890'])
    with pytest.raises(RuntimeError) as exc:
        settings.validate_production()
    assert 'Cuenta bancaria LIVE sin cuenta Connect autorizada' in str(exc.value)
