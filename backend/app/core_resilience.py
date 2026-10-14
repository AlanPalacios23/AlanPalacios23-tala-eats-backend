from __future__ import annotations

import json
import logging
import secrets
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import event, inspect
from sqlalchemy.orm import Session

from . import models
from .order_state import assert_transition
from .request_context import request_id_var, request_ip_var, device_session_id_var

log = logging.getLogger("talaeats.domain")
_registered = False


def _json_value(value):
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def _event_row(event_key: str, order: models.Order, event_type: str, payload: dict) -> models.EventOutbox:
    return models.EventOutbox(
        event_key=event_key[:220],
        aggregate_type="order",
        aggregate_id=str(order.id or "pending"),
        event_type=event_type,
        payload_json=json.dumps(payload, ensure_ascii=False, default=_json_value, separators=(",", ":")),
    )


def register_domain_guards() -> None:
    global _registered
    if _registered:
        return
    _registered = True

    @event.listens_for(Session, "before_flush")
    def _validate_and_capture(session: Session, flush_context, instances):  # noqa: ARG001
        # A session flag prevents recursive duplicate generation during autoflush.
        if session.info.get("v14_domain_capture"):
            return
        session.info["v14_domain_capture"] = True
        try:
            for obj in list(session.deleted):
                if isinstance(obj, models.AuditEvent):
                    raise RuntimeError("audit_events is append-only")
            for obj in list(session.new) + list(session.dirty):
                if isinstance(obj, models.AuditEvent):
                    if obj not in session.new and inspect(obj).modified:
                        raise RuntimeError("audit_events is append-only")
                    obj.request_id = obj.request_id or request_id_var.get()
                    obj.ip_address = obj.ip_address or request_ip_var.get()
                    obj.device_session_id = obj.device_session_id or session.info.get("device_session_id") or device_session_id_var.get()
                    continue
                if isinstance(obj, (models.Restaurant, models.MenuItem)):
                    state = inspect(obj)
                    changed = obj in session.new or any(attr.history.has_changes() for attr in state.attrs)
                    if changed:
                        restaurant_id = obj.id if isinstance(obj, models.Restaurant) else obj.restaurant_id
                        nonce = secrets.token_hex(6)
                        session.add(models.EventOutbox(
                            event_key=f"catalog:{obj.__class__.__name__.lower()}:{getattr(obj, 'id', None) or nonce}:{nonce}",
                            aggregate_type="catalog", aggregate_id=str(restaurant_id or "pending"),
                            event_type="catalog.changed",
                            payload_json=json.dumps({"restaurant_id": restaurant_id, "entity": obj.__class__.__name__}, separators=(",", ":")),
                        ))
                    continue
                if not isinstance(obj, models.Order):
                    continue
                state = inspect(obj)
                status_hist = state.attrs.status.history
                payment_hist = state.attrs.payment_status.history
                driver_hist = state.attrs.driver_id.history

                if obj not in session.new and status_hist.has_changes():
                    previous = status_hist.deleted[0] if status_hist.deleted else None
                    current = status_hist.added[0] if status_hist.added else obj.status
                    via = []
                    if previous == "preparing" and current == "assigned" and obj.ready_at is not None and obj.driver_id is not None:
                        # Restaurant marked READY and auto-dispatch claimed a driver before
                        # the transaction flushed. Validate the two real transitions.
                        assert_transition("preparing", "ready", order_type=obj.order_type)
                        assert_transition("ready", "assigned", order_type=obj.order_type)
                        via = ["ready"]
                    else:
                        assert_transition(previous, current, order_type=obj.order_type)
                    nonce = secrets.token_hex(6)
                    session.add(_event_row(
                        f"order:{obj.id}:status:{previous}:{current}:{nonce}",
                        obj,
                        "order.status_changed",
                        {"order_id": obj.id, "previous": previous, "status": current, "driver_id": obj.driver_id, "via": via},
                    ))

                if obj not in session.new and payment_hist.has_changes():
                    previous = payment_hist.deleted[0] if payment_hist.deleted else None
                    current = payment_hist.added[0] if payment_hist.added else obj.payment_status
                    nonce = secrets.token_hex(6)
                    session.add(_event_row(
                        f"order:{obj.id}:payment:{previous}:{current}:{nonce}",
                        obj,
                        "payment.status_changed",
                        {"order_id": obj.id, "previous": previous, "payment_status": current, "status": obj.status},
                    ))

                if obj not in session.new and driver_hist.has_changes():
                    previous = driver_hist.deleted[0] if driver_hist.deleted else None
                    current = driver_hist.added[0] if driver_hist.added else obj.driver_id
                    nonce = secrets.token_hex(6)
                    session.add(_event_row(
                        f"order:{obj.id}:driver:{previous}:{current}:{nonce}",
                        obj,
                        "driver.assignment_changed",
                        {"order_id": obj.id, "previous_driver_id": previous, "driver_id": current, "status": obj.status},
                    ))
        finally:
            session.info.pop("v14_domain_capture", None)


register_domain_guards()
