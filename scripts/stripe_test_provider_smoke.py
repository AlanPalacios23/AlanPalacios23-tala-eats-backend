"""Manual Stripe TEST-only provider smoke; NO production backend nor live funds.

Requires GITHUB SECRET TALAEATS_STRIPE_TEST_SECRET_KEY (sk_test_*).
Creates a test-mode PaymentIntent, confirms with test fixture card and refunds it.
All money movements are purely within Stripe's sandbox.
"""
import os
import sys
import uuid

def main():
    key = os.environ.get("TALAEATS_STRIPE_TEST_SECRET_KEY", "")
    if not key.startswith("sk_test_") or key.startswith(("sk_live_", "rk_live_")):
        raise SystemExit("REFUSED: GitHub must contain a secret Stripe sk_test_ key")
    if os.environ.get("STRIPE_LIVE_MODE", "").lower() in {"1", "true", "yes"}:
        raise SystemExit("REFUSED: LIVE mode is forbidden")
    from stripe import StripeClient
    client = StripeClient(key, max_network_retries=1)
    run_id = "tala-qa-" + uuid.uuid4().hex
    intent = None
    try:
        body = {
            "amount": 1000, "currency": "mxn",
            "payment_method": "pm_card_visa", "confirm": True,
            "automatic_payment_methods": {"enabled": True, "allow_redirects": "never"},
            "metadata": {"tala_ci": run_id, "test_only": "true"},
        }
        intent = client.v1.payment_intents.create(
            body, options={"idempotency_key": run_id + ":intent"})
        assert not intent.livemode and intent.status == "succeeded"
        again = client.v1.payment_intents.create(
            body, options={"idempotency_key": run_id + ":intent"})
        assert again.id == intent.id
        refund = client.v1.refunds.create(
            {"payment_intent": intent.id, "amount": 1000,
             "metadata": {"tala_ci": run_id, "test_only": "true"}},
            options={"idempotency_key": run_id + ":refund"})
        assert not refund.livemode and refund.status in {"succeeded", "pending"}
        repeat = client.v1.refunds.create(
            {"payment_intent": intent.id, "amount": 1000,
             "metadata": {"tala_ci": run_id, "test_only": "true"}},
            options={"idempotency_key": run_id + ":refund"})
        assert repeat.id == refund.id
        print("STRIPE_PROVIDER_TEST_MODE_PASS: intent, idempotency and refund")
    except Exception:
        # Do not print exceptions as they may contain provider responses or
        # sensitive request metadata. A CI artifact is not a secrets vault.
        print("STRIPE_PROVIDER_TEST_MODE_FAIL: check Stripe TEST dashboard", file=sys.stderr)
        raise SystemExit(1)
    finally:
        # Compensating best-effort refund for a test payment if a test assertion
        # failed after successful confirmation, never reuses a second key.
        if intent is not None and intent.status == "succeeded":
            try:
                client.v1.refunds.create(
                    {"payment_intent": intent.id, "amount": 1000,
                     "metadata": {"tala_ci": run_id, "test_only": "true"}},
                    options={"idempotency_key": run_id + ":refund"})
            except Exception:
                print("TEST-only refund reconciliation requires review in Stripe TEST", file=sys.stderr)


if __name__ == "__main__":
    main()
