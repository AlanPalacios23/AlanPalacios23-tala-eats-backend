# RC12.2 — Tala Eats pickup cash pilot

## Purpose

Allow a restricted, verifiable cash-at-restaurant pickup in the production
marketplace without borrowing the staging cash permission. The current live
operator env already has Stripe LIVE pickup financial flags ON and the
*legacy* `STAGE_PICKUP_CASH_CHECKOUT_ENABLED=ON`; this legacy flag must not
authorize LIVE cash after deploying RC12.2.

## Safeguards

- New production-only paired flags:
  `LIVE_PICKUP_CASH_CHECKOUT_ENABLED=true` and
  `LIVE_PICKUP_CASH_RELEASE_APPROVED=true`.
  They default OFF and reject partial release at startup.
- New release helper is shared by the customer checkout route, order
  transaction, seller lifecycle, cash cancellation and merchant handoff PIN.
  The public pickup-capability endpoint must not use the legacy stage switch.
- Merchant must have verified and approved onboarding, be open and support
  pickup, have an active restaurant-role owner and an owner-approved Connect
  mapping distinct from the platform's own account. Production Stripe card
  pickup now receives the same local merchant approval check at order creation.
- PIN authentication is rate-limited using separate stage and LIVE Redis
  namespaces. Cash collection is an idempotent physical merchant receipt,
  not a Stripe bank credit, payout or withdrawable earning.
- No LIVE card delivery or bank disbursement is released. This document is
  NOT a full launch authorization.

## Actual live facts on 2026-10-29

Previous operator RC119 diagnosis showed one restaurant, zero verified,
zero active owners, zero approved mappings, one verified but offline courier.
Under these conditions a cash pickup release must **HOLD** until a real
merchant is approved and its catalog and account mapping are proven.

## Deployment order for operator on Kali

1. Run all GitHub Actions checks, prepare the exact approved immutable SHA,
   and use existing `rc117-kali-live-code-release.sh` code-only promotion
   preserving the previous release for rollback.
2. Confirm two PM2 identities, LIVE Postgres, signed webhook and public API
   readiness, plus exact merchant approval. Run:
   `node --env-file="$HOME/.config/talaeats-node-live.env" scripts/rc814-pickup-readiness-audit.mjs`
   (read only).
3. Do not call the old cash activator before code-only rollout. After code
   rollout, use the `rc814-enable-live-pickup-cash.py` script in `--plan`
   with pinned active SHA; it now checks verified merchant presence and
   changes only the new LIVE pair, not stage.
4. Only with a real eligible merchant and independently verified seller
   Stripe/contract information, explicitly opt into
   `--activate <SHA> I_APPROVE_RC814_PRODUCTION_CASH_PICKUP_ONLY`.
   Activator backups the private env, writes both flags atomically, restarts
   API, checks local+public health, and attempts rollback on failure.
5. Verify public pickup capabilities, make one low-value paid-on-handoff
   pilot order, prove owner acceptance and handoff PIN and immutable
   `cash_pickup_collection` ledger, check alerts and rollback. Pause new
   checkout on a mismatch.

## Still blocked

- Cash to home LIVE: three dedicated delivery flags OFF and no eligible
  nearby online verified driver in current operator snapshot.
- Stripe card to home LIVE: production source explicitly forbids it.
- Stripe Connect transfers and bank withdrawals: production gate hard
  disabled; require separate reviewed execution, real recipients,
  available settled beneficiary funds and signed bank payout reconciliation.
- Real backups, alert receipt and multi-PWA E2E pilot proof not supplied.
