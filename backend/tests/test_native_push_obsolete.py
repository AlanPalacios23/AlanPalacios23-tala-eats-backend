"""Regresiones de notificaciones obsoletas; sin red FCM ni producción."""
from types import SimpleNamespace

import pytest

from app.native_push import _obsolete_order_push


def note(kind="order", title="Pedido confirmado", message="Pedido #91"):
    return SimpleNamespace(kind=kind, title=title, message=message)


def order(status="confirmed", user_id=41, driver_id=92):
    return SimpleNamespace(status=status, user_id=user_id, driver_id=driver_id)


@pytest.mark.parametrize("status", ["preparing", "ready", "assigned", "on_the_way", "delivered", "cancelled"])
def test_old_confirmation_is_suppressed_when_order_advanced(status):
    assert _obsolete_order_push(note(), "customer", 41, order(status=status))


def test_current_state_notification_still_sends():
    assert not _obsolete_order_push(note(), "customer", 41, order())
    assert not _obsolete_order_push(
        note(title="En camino"), "customer", 41, order(status="on_the_way")
    )


def test_private_order_alert_never_reaches_other_customer():
    assert _obsolete_order_push(note(), "customer", 42, order())


def test_driver_reassignment_invalidates_old_driver_notification():
    msg = note(kind="delivery", title="Nueva entrega asignada")
    assert _obsolete_order_push(msg, "driver", 91, order(status="assigned", driver_id=92))
    assert not _obsolete_order_push(msg, "driver", 92, order(status="assigned", driver_id=92))


def test_old_driver_offer_suppressed_after_pickup():
    assert _obsolete_order_push(
        note(kind="driver_offer", title="Oferta nueva"), "driver", 92,
        order(status="picked_up"),
    )
    assert not _obsolete_order_push(
        note(kind="driver_offer", title="Oferta nueva"), "driver", 92,
        order(status="ready"),
    )


@pytest.mark.parametrize("kind", ["payment", "security", "refund", "withdrawal"])
def test_critical_transactional_notices_are_not_suppressed_by_order_progress(kind):
    msg = note(kind=kind)
    assert not _obsolete_order_push(msg, "customer", 41, order(status="delivered"))


def test_unknown_legacy_order_notice_keeps_existing_contract():
    assert not _obsolete_order_push(
        note(title="Consulta de soporte"), "customer", 41,
        order(status="delivered"),
    )
