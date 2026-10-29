# RC12.3 — Tala Eats day-to-day commercial pilot (four checkout modes)

**Scope:** NEW real businesses, NEW drivers and NEW customers. Existing
disposable pilot accounts are not a condition for accepting new registrations.
Production release is **not** approved by a unit-test or GitHub CI alone.

## Four independent operational gates

| Order | Production admission | Real-world proof |
|---|---|---|
| Pickup + cash | LIVE_PICKUP_CASH_CHECKOUT_ENABLED + LIVE_PICKUP_CASH_RELEASE_APPROVED | Approved seller, stock, merchant pickup PIN, immutable cash-collected ledger |
| Pickup + card | STRIPE_LIVE_ENABLED + STRIPE_LIVE_RELEASE_APPROVED + STRIPE_FINANCIAL_WRITES_ENABLED + STRIPE_REFUNDS_ENABLED + STRIPE_MANUAL_SETTLEMENT_APPROVED | Signed Stripe capture, seller/kitchen handoff PIN, reconciliation and refund |
| Home delivery + cash | LIVE_DELIVERY_CASH_CHECKOUT_ENABLED + LIVE_DELIVERY_CASH_DISPATCH_ENABLED + LIVE_DELIVERY_CASH_RELEASE_APPROVED | Verified driver and fresh GPS, dispatch, proof of cash collected, driver PIN, cash debt ledger |
| Home delivery + card | LIVE_DELIVERY_DISPATCH_ENABLED + LIVE_DELIVERY_CARD_CHECKOUT_ENABLED + LIVE_DELIVERY_RELEASE_APPROVED + LIVE_DELIVERY_CARD_E2E_APPROVED | Stripe TEST end-to-end on three PWAs, signed payment, driver assignment and delivery, refund/dispute/cancel recovery |

All four release flags for LIVE **card delivery** must be simultaneously
true or the server refuses to boot. They also require the existing approved
Stripe LIVE configuration, refunds/manual settlement, MARKETPLACE_B and
AUTH_V02, real driver presence, production-only storage, and no STAGE delivery
flags. A source-code commit or simulated payment is NOT the required
E2E approval. **Default OFF.**

## Customer day-to-day order

1. Approve real owner application via ADMIN; owner must log back in. Verify
   physical business identity; attach only that owner's Stripe Connect and
   get owner approval. Business becomes verified only after real review.
2. Merchant sets location, pickup preference, opening hours, menu, stock and
   opens store in Restaurants PWA.
3. Customer sees the relevant checkout modes only after server payment-method
   and per-merchant **pickup or delivery** readiness. Delivery also requires
   a reachable verified driver with fresh GPS.
4. The buyer sees an independent server quote and confirms **once**, with
   durable client reference. For card: never tell kitchen it is paid before
   Stripe LIVE signed webhook and ledger receipt. For cash: no Stripe charge.
5. Restaurant accepts, prepares, marks READY; delivery auto-dispatch uses GPS,
   pickup or delivery needs PIN. Outbox/Web Push should wake actors but server
   order state remains source of truth.
6. Cancellations/refunds/disputes mark money HOLD and never fake settled,
   merchant-payable or driver bank balances. Confirm real financial receipts.
7. Customer support sees disputes; ops can stop new checkouts and roll back
   code. No automatic Connect transfers/bank withdrawals until their separate
   production execution and reconciled available balance is proven.

## Release discipline

- Deploy backend code-only first, pinning exact commit, checking 2 PM2 processes,
  live PG/Redis, /ready, API/PWA routes and signed webhook. Snapshot/rollback.
- Deploy matching Customer PWA **after** backend adds /delivery-readiness,
  without altering Stripe keys or production data.
- Run isolated real-device/customer-restaurant-driver E2E in Stripe TEST and
  separate cash scenarios, including retries, failure/recovery, zero drivers,
  duplicate client references, stock exhaustion, PIN replay, refund/dispute.
- Only then individually enable pickup cash, delivery cash and card delivery
  controls with evidence, approved sellers, canary limits and rollback.
- **NO-GO** if payout/withdrawal claims are advertised as enabled, a card is
  marked paid without signed capture, or any cash charge is counted as Stripe
  available bank balance.
- NO manually writing verified user/shop/driver flags into production DB to
  circumvent ADMIN onboarding. NO reusing disposable accounts as real sellers.

## Remaining independent work

The treasury bank-withdrawal executor is still hard-locked in production.
Do not advertise a working "retirar ganancias" button until verified
bank accounts, durable fund reservation, double authorization, idempotent
Stripe execution and payout webhook reconciliation all pass TEST and LIVE
canary. Merchant cash settlement must never be shown as cash held by Stripe.
