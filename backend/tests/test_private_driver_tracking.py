"""Regression tests for private, freshness-aware customer tracking (issue #22).

No live GPS, external network, real customer or production backend required.
"""
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app import realtime
from app.routes import v11


def order(status="assigned", *, user_id=7, driver_id=20, order_type="delivery", lat=20.65, lng=-103.7):
    profile = SimpleNamespace(current_lat=lat, current_lng=lng)
    return SimpleNamespace(
        user_id=user_id, driver_id=driver_id, status=status,
        order_type=order_type, driver=SimpleNamespace(driver_profile=profile),
    )


@pytest.fixture
def customer():
    return SimpleNamespace(id=7, role="customer")


def test_live_position_only_for_owner_of_current_active_delivery(monkeypatch, customer):
    calls = []
    monkeypatch.setattr(v11, "driver_location_snapshot", lambda driver_id: calls.append(driver_id) or
                        {"lat": 20.5, "lng": -103.5, "source": "redis",
                         "reported_at": datetime.now(timezone.utc).isoformat(), "is_fresh": True})
    assigned_at = datetime.now(timezone.utc) - timedelta(seconds=15)
    for state in ("assigned", "picked_up", "on_the_way"):
        sample = v11._customer_driver_location(order(state), customer, assigned_at=assigned_at)
        assert sample["source"] == "redis"
        assert sample["is_fresh"] is True
    assert calls == [20, 20, 20]

    denied = [
        (order("received"), customer),
        (order("delivered"), customer),
        (order("cancelled"), customer),
        (order("assigned", order_type="pickup"), customer),
        (order("assigned", driver_id=None), customer),
        (order("assigned", user_id=8), customer),
        (order(), SimpleNamespace(id=8, role="customer")),
        (order(), SimpleNamespace(id=7, role="admin")),
        (order(), SimpleNamespace(id=7, role="restaurant")),
        (order(), SimpleNamespace(id=7, role="driver")),
    ]
    for candidate, principal in denied:
        assert v11._customer_driver_location(candidate, principal, assigned_at=assigned_at) is None
    assert calls == [20, 20, 20]


def test_redis_absent_never_exposes_unverified_database_gps(monkeypatch, customer):
    monkeypatch.setattr(v11, "driver_location_snapshot", lambda _: None)
    assigned_at = datetime.now(timezone.utc) - timedelta(seconds=15)
    assert v11._customer_driver_location(order(), customer, assigned_at=assigned_at) is None
    assert v11._customer_driver_location(order(lat=None), customer, assigned_at=assigned_at) is None


def test_reassignment_rejects_ping_from_previous_delivery(monkeypatch, customer):
    now = datetime.now(timezone.utc)
    sample = {"lat": 20.5, "lng": -103.5, "source": "redis",
              "reported_at": (now - timedelta(seconds=30)).isoformat(), "is_fresh": True}
    monkeypatch.setattr(v11, "driver_location_snapshot", lambda _: sample)
    assert v11._customer_driver_location(order(), customer, assigned_at=None) is None
    assert v11._customer_driver_location(
        order(), customer, assigned_at=now - timedelta(seconds=10)
    ) is None
    assert v11._customer_driver_location(
        order(), customer, assigned_at=now - timedelta(seconds=60)
    ) == sample
    sample["reported_at"] = None
    assert v11._customer_driver_location(
        order(), customer, assigned_at=now - timedelta(seconds=60)
    ) is None


class FakeRedis:
    def __init__(self, payload):
        self.payload = payload
        self.keys = []

    def get(self, key):
        self.keys.append(key)
        return self.payload


def test_redis_snapshot_timestamp_and_invalid_coordinates(monkeypatch):
    now = datetime.now(timezone.utc)
    client = FakeRedis(json.dumps({
        "lat": 20.65, "lng": -103.70, "reported_at": now.isoformat(),
    }))
    monkeypatch.setattr(realtime, "_sync", lambda: client)
    result = realtime.driver_location_snapshot(55)
    assert client.keys == ["talaeats:driver:55:location"]
    assert result["source"] == "redis" and result["is_fresh"] is True
    assert result["reported_at"] is not None

    for payload in (
        {"lat": 20.65, "lng": -103.70},
        {"lat": 20.65, "lng": -103.70, "reported_at": (now-timedelta(seconds=100)).isoformat()},
        {"lat": 20.65, "lng": -103.70, "reported_at": (now+timedelta(minutes=2)).isoformat()},
    ):
        client.payload = json.dumps(payload)
        value = realtime.driver_location_snapshot(55)
        assert value["is_fresh"] is False

    for bad in (
        {"lat": 91, "lng": 0},
        {"lat": 20.65, "lng": "NaN"},
        {"lat": 20.65},
    ):
        client.payload = json.dumps(bad)
        assert realtime.driver_location_snapshot(55) is None


def test_missing_redis_does_not_report_fresh(monkeypatch):
    monkeypatch.setattr(realtime, "_sync", lambda: None)
    assert realtime.driver_location_snapshot(20) is None
