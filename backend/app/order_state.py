from __future__ import annotations

from dataclasses import dataclass


class InvalidOrderTransition(ValueError):
    pass


# Central state contract shared by customer, restaurant, driver, ADMIN and workers.
# A few backward transitions are intentionally allowed only because KDS supports an
# explicit undo action. Business routes still apply their narrower role rules.
_ALLOWED: dict[str, set[str]] = {
    "received": {"confirmed", "cancelled"},
    "confirmed": {"received", "preparing", "cancelled"},
    "preparing": {"confirmed", "ready", "cancelled"},
    "ready": {"preparing", "assigned", "on_the_way", "delivered", "cancelled"},
    "assigned": {"picked_up", "ready", "cancelled"},
    "picked_up": {"on_the_way", "cancelled"},
    "on_the_way": {"delivered", "cancelled"},
    # A completed order may be financially reversed by an ADMIN/provider flow. The
    # delivery event remains immutable in OrderEvent/audit/outbox.
    "delivered": {"cancelled"},
    "cancelled": set(),
}


@dataclass(frozen=True)
class TransitionDecision:
    previous: str | None
    current: str
    valid: bool
    reason: str = ""


def validate_transition(previous: str | None, current: str, *, order_type: str = "delivery") -> TransitionDecision:
    if previous is None or previous == current:
        return TransitionDecision(previous, current, True)
    if previous not in _ALLOWED:
        return TransitionDecision(previous, current, False, f"Estado origen desconocido: {previous}")
    allowed = set(_ALLOWED[previous])
    if previous == "ready" and order_type != "pickup":
        # Direct ready -> delivered is only valid for pickup handoff.
        allowed.discard("delivered")
    if current not in allowed:
        return TransitionDecision(previous, current, False, f"Transición inválida: {previous} → {current}")
    return TransitionDecision(previous, current, True)


def assert_transition(previous: str | None, current: str, *, order_type: str = "delivery") -> None:
    decision = validate_transition(previous, current, order_type=order_type)
    if not decision.valid:
        raise InvalidOrderTransition(decision.reason)
