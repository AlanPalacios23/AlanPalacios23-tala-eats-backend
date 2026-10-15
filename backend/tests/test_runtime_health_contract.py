"""Health semantics and proxy production configuration without external services."""
import pytest

from app import main
from app.config import settings


def test_health_reports_truthful_checkout_when_dependencies_fail(monkeypatch):
    monkeypatch.setattr(main, "_dependency_health", lambda: (False, True, None))
    report = main.health()
    assert report["status"] == "degraded"
    assert report["core_checkout"] == "degraded"
    assert report["worker_heartbeat_detected"] is False
    assert report["finance_v2"]["bank_reconciliation_verified"] is False
    assert report["finance_v2"]["automatic_settlements_enabled"] is False


def test_readiness_keeps_http_contract_without_falsely_claiming_worker(monkeypatch):
    monkeypatch.setattr(main, "_dependency_health", lambda: (True, True, None))
    healthy = main.readiness()
    assert healthy.status_code == 200
    assert b'"ready":true' in healthy.body
    assert b'"worker_heartbeat_detected":false' in healthy.body
    monkeypatch.setattr(main, "_dependency_health", lambda: (False, True, None))
    down = main.readiness()
    assert down.status_code == 503
    assert b'"ready":false' in down.body


@pytest.mark.parametrize("invalid", ["0.0.0.0/0", "::/0", "not-a-cidr"])
def test_production_rejects_unsafe_proxy_cidrs(monkeypatch, invalid):
    monkeypatch.setattr(settings, "environment", "production")
    monkeypatch.setattr(settings, "trust_proxy_headers", True)
    monkeypatch.setattr(settings, "trusted_proxy_cidrs", [invalid])
    with pytest.raises(RuntimeError) as exc:
        settings.validate_production()
    assert "TRUSTED_PROXY_CIDRS" in str(exc.value)
