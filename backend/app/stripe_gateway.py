"""Stripe API boundary: all provider calls are through StripeClient, never global API key state.

This provider is disabled by default. No payment-side effects are implemented
by success URLs or by optimistic UI responses.
"""
from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP
from fastapi import HTTPException
from .config import settings


def money_cents(amount: Decimal | str | float) -> int:
    amount = Decimal(str(amount))
    if not amount.is_finite() or amount < 0:
        raise ValueError("Monto de Stripe inválido")
    return int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def stripe_client():
    if not (settings.stripe_enabled and settings.stripe_secret_key and settings.stripe_webhook_secret):
        raise HTTPException(503, "Stripe no está configurado en este servidor")
    try:
        from stripe import StripeClient
    except ImportError as exc:
        raise HTTPException(503, "Stripe SDK no está instalado") from exc
    return StripeClient(settings.stripe_secret_key, max_network_retries=2)


def intent_create(client, order, idempotency_key: str):
    # Dynamic methods: do not set payment_method_types. Eligibility for Apple
    # Pay/Google Pay is evaluated by the mobile SDK and Stripe/OS/device.
    return client.v1.payment_intents.create({
        "amount": money_cents(order.total),
        "currency": "mxn",
        "metadata": {"tala_order_id": str(order.id), "customer_id": str(order.user_id),
                     "restaurant_id": str(order.restaurant_id)},
        "description": f"Tala Eats pedido #{order.id}",
        "automatic_payment_methods": {"enabled": True, "allow_redirects": "never"},
        "transfer_group": f"tala_order_{order.id}",
    }, options={"idempotency_key": idempotency_key})


def intent_retrieve(client, intent_id: str):
    return client.v1.payment_intents.retrieve(intent_id)


def refund_create(client, intent_id: str, amount_cents: int, key: str):
    return client.v1.refunds.create({
        "payment_intent": intent_id,
        "amount": amount_cents,
        "reason": "requested_by_customer",
        "metadata": {"tala_refund_key": key},
    }, options={"idempotency_key": key})


def transfer_create(client, charge_id: str, account_id: str, amount_cents: int, order_id: int, role: str):
    return client.v1.transfers.create({
        "amount": amount_cents,
        "currency": "mxn",
        "destination": account_id,
        "source_transaction": charge_id,
        "transfer_group": f"tala_order_{order_id}",
        "metadata": {"tala_order_id": str(order_id), "recipient_type": role},
    }, options={"idempotency_key": f"tala:stripe:transfer:v1:{order_id}:{role}"})


def parse_webhook(payload: bytes, sig: str):
    if not settings.stripe_enabled or not settings.stripe_webhook_secret:
        raise HTTPException(503, "Webhook Stripe inactivo")
    if not sig:
        raise HTTPException(400, "Falta Stripe-Signature")
    try:
        from stripe import Webhook
        return Webhook.construct_event(payload, sig, settings.stripe_webhook_secret, tolerance=settings.stripe_max_event_age)
    except Exception as exc:
        raise HTTPException(400, "Firma o contenido de Stripe inválido") from exc


def data_dict(obj):
    if isinstance(obj, dict):
        return obj
    if hasattr(obj, "to_dict"):
        return obj.to_dict(for_json=True)
    return dict(obj)
