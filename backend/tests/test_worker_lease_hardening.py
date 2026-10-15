"""Protect scheduled maintenance from stale Redis worker leases.

No real Redis, Stripe API calls or money transfers.
"""
import pytest

from app import worker


class FakeWorkerRedis:
    def __init__(self, result):
        self.result = result
        self.calls = []
    def eval(self, script, key_count, *args):
        self.calls.append((script, key_count, args))
        return self.result


def test_refresh_returns_true_only_for_still_owned_lock(monkeypatch):
    fake = FakeWorkerRedis(1)
    monkeypatch.setattr(worker, "_redis_client", lambda: fake)
    assert worker._refresh_cycle_lock("owner-a") is True
    assert len(fake.calls) == 1
    script, key_count, args = fake.calls[0]
    assert key_count == 1
    assert "expire" in script and "get" in script
    assert args[1] == "owner-a"
    fake.result = 0
    assert worker._refresh_cycle_lock("owner-a") is False
    assert worker._refresh_cycle_lock("local-development") is True
    assert worker._refresh_cycle_lock(None) is True


def test_redis_lease_loss_stops_all_later_jobs(monkeypatch):
    monkeypatch.setattr(worker, "write_heartbeat", lambda: None)
    monkeypatch.setattr(worker, "process_outbox", lambda db: (0, 0, 0))
    monkeypatch.setattr(worker, "expire_unpaid_orders", lambda: 0)
    monkeypatch.setattr(worker, "_refresh_cycle_lock", lambda token: False)
    def should_not_run():
        raise AssertionError("Lost worker lease must stop any subsequent job")
    monkeypatch.setattr(worker, "cleanup_orphan_proofs", should_not_run)
    worker.run_once(lock_token="expired-token")


def test_worker_refresh_failure_is_fail_closed(monkeypatch):
    class BrokenRedis:
        def eval(self, *args):
            raise ConnectionError("redis out of service in isolated test")
    monkeypatch.setattr(worker, "_redis_client", lambda: BrokenRedis())
    assert worker._refresh_cycle_lock("owner-a") is False
