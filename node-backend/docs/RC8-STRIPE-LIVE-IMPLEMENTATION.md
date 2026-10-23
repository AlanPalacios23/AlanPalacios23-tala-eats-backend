# TALA EATS RC8 — Stripe LIVE engineering version (NOT deployed)

## Implementation status

This is a **separate production-payment code path**, not a switch to make RC7
charge cards. RC7 remains running on Kali as stage commit
`343579328c51eb0e4de8751fa8bab6c23c523662`, with test-only config.
Live code is deliberately **NOT imported by the RC7 API or worker**.

### Implemented in this branch

- `src/live/guard.ts`: isolated production environment validation,
  `rk_live_` (preferred) / `sk_live_`, publishable `pk_live_`,
  webhook `whsec_`, independent PostgreSQL and Redis, human release signoff,
  MXN payment upper limit 50,000 minor units (MXN 500), maximum configurable
  **pilot** limit; Connect transfers remain prohibited.
- `src/live/postgres-store.ts`: atomic PostgreSQL reservation before any
  remote call, buyer-scoped owner enforcement, compare-and-swap attach, and
  30-minute idempotency. Does NOT call Stripe by itself.
- `src/live/stripe-payments.ts`: Stripe LIVE PaymentIntent only for the
  authenticated buyer's existing, server-priced pickup order, bounded card-only
  flow without redirects, immutable amount, remote mode/owner verification,
  never reuses a captured intent, signs webhook body verification helper.
- `src/live/reconcile.ts`: signed webhook replay protection, Stripe event
  and intent remote re-fetch, ACID order+immutable ledger+durable outbox commit,
  idempotency under duplicate events and explicit rejection of Connect
  sub-account events; *never* transfers or pays out funds.
- `tests/rc8-stripe-live-isolation.test.mjs`: pure tests with synthetic
  Stripe provider; **no LIVE API calls** and no live keys used.

**This is a development milestone, not a public HTTP entrypoint or complete
LIVE checkout.** The database adapter is intended for a future independent,
migrated production PostgreSQL environment. Existing stage DB/Redis cannot be
used for it. No finance endpoint is mounted in RC7. No new host service or
`.env` on Kali is created by this PR.

## Required before any live charge (strict NO-GO pending)

1. Provision independent production PostgreSQL/Redis, backup+restore, migration
   of actual users/restaurants/orders and verify all required accounts.
2. Build standalone production API/auth/worker using audited rate limits,
   authenticated buyers, item price/stock atomics, vendor approval,
   protected secret manager and signed webhook ingress. Finish crash recovery
   for `pi_reserving_rc8_live` before accepting money.
3. Implement idempotent, operator-audited **full/partial refunds**, Stripe
   disputes, chargebacks, ledger reversals and compensating inventory.
   Unhandled refunds must never be counted as seller entitlement.
4. Implement real Android/iOS **PaymentSheet** with correct customer receipt,
   declined card/3DS/offline/duplicate/timeout scenarios and seller KDS
   visibility after webhook success. Play Store release separate.
5. Implement **Stripe Connect Accounts v2** recipients (merchant/courier),
   hosted/embedded onboarding, KYC, capability `configuration.recipient.
   capabilities.stripe_balance.stripe_transfers.status === 'active'`,
   split ledger, safe delayed separate charges/transfers, reversals and payouts.
   No `application_fee_amount` with separate charges/transfers.
6. Confirm customer 7%, merchant 15%, tips 0% commission, fee/tax treatment,
   pickup/delivery policy MXN 39 target vs legacy 35, transport insurance,
   KYC/dispute support, invoices and fiscal terms.
7. Run real TEST sandbox payments + signed webhooks + duplicate/out-of-order,
   refund test and independently review LIVE key permissions. Only then,
   with a go/no-go signoff, perform a low-value operator-authorized live
   transaction and refund with alerting and rollback.

Use Stripe **restricted LIVE API key** with only strictly necessary permissions
and private secret storage; never paste keys into chat, GitHub, the app or
server logs. Do not reuse the RC7 staging `.env`.

### Isolation proof

No existing release scripts, `NODE_ENV=staging` config, stage routes,
`webhook.ts`, `worker.ts`, PM2, Cloudflared, PostgreSQL or Redis are
changed by this branch. The isolated production modules are library code;
they do nothing unless a separately reviewed production runtime invokes them.

**Do NOT deploy this branch with the RC7 staging release promoter**: it is not
a completed live production deployment, and the promoter is restricted to
`tala-node-stage`. Leaving the live modules unmounted is intentional.
