"""FCM presentation policy: payment/security alerts are never promotions.

These tests have no Firebase credentials, network or real customer devices.
"""
import pytest
from app.native_push import fcm_delivery_policy


@pytest.mark.parametrize("kind", [
    "payment", "security", "account", "authentication", "refund", "withdrawal",
])
def test_critical_alert_without_order_id_uses_transactional_channel(kind):
    policy = fcm_delivery_policy(kind)
    assert policy["channel"] == "orders"
    assert policy["priority"] == "high"
    assert policy["kind"] == "inbox"
    assert policy["sound"] == "default"
    assert policy["ttl"] == "86400s"


@pytest.mark.parametrize("kind", [
    "order", "restaurant_order", "driver_order", "delivery", "driver_offer",
])
def test_order_event_remains_urgent_without_text_order_id(kind):
    policy = fcm_delivery_policy(kind)
    assert policy["channel"] == "orders"
    assert policy["kind"] == "order"
    assert policy["priority"] == "high"
    assert policy["ttl"] == "21600s"


@pytest.mark.parametrize("kind", ["growth", "marketing", "promotion", "sponsored", "promo"])
def test_only_explicit_marketing_uses_promotions(kind):
    p = fcm_delivery_policy(kind)
    assert p["channel"] == "promotions"
    assert p["priority"] == "normal"
    assert p["kind"] == "promotion"
    assert p["sound"] == ""


def test_legacy_order_id_keeps_order_channel():
    p = fcm_delivery_policy("inbox", "183")
    assert p["channel"] == "orders"
    assert p["kind"] == "order"
    assert p["ttl"] == "21600s"
    assert p["priority"] == "high"


def test_unknown_kind_not_silenced_by_marketing_opt_out():
    p = fcm_delivery_policy("operational_notice")
    assert p["channel"] != "promotions"
    assert p["priority"] == "normal"
