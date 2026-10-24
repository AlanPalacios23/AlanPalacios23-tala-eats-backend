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

### Hardening increment for next Kali deployment review

- Prevent ineligible amount, corrupted provider ID and expired (>30 minute)
  order from writing `pi_reserving_rc8_live` to PostgreSQL at all. The
  maximum amount check runs **under the order row lock before reservation**.
- Re-fetching existing PaymentIntent must match its exact stored ID; metadata
  matching alone is not enough.
- Recover a provider-created-but-not-attached PaymentIntent after an API crash
  **only from a signed, LIVE Stripe event and a remote-fetched intent**, under
  an order row lock with exact amount, buyer ID, order ID, mode and status.
- `src/live/webhook-inbox.ts` stores signed payment events durably before
  acknowledging HTTP; a future dedicated worker can reconcile bounded retries
  using Stripe-retrieved events. Failures stay RECEIVED for investigation.
- Signed **refund and dispute** events are not dropped: record durable HOLD
  receipts even though reversal accounting is deliberately not implemented.
  Do not mark such receipts PROCESSED until the reversal and liability logic
  is reviewed.
- `src/live/financial-readiness.ts`: aggregate read-only PASS/HOLD counters
  for unprocessed payment receipts, refund/dispute events, captured orders
  missing the unique LIVE ledger proof, and old reserved PaymentIntents.
  PASS is necessary but does **not** authorize commercial checkout.
- `scripts/rc8-kali-next-deployment-preflight.sh --plan <40-char-RC8-SHA>`
  verifies RC7 remains the active PM2 release and payments stay disabled,
  while validating the reviewed RC8 source from a separate checkout. It does
  not change PostgreSQL, Cloudflared, PM2 or Stripe.
- New unit tests cover expired orders, price ceilings, provider-ID mismatch,
  signed durable webhook storage and immutable event identity, reversal HOLD,
  backlog inspection and deployment script syntax.

**This is a development milestone, not a public HTTP entrypoint or complete
LIVE checkout.** The database adapter is intended for a future independent,
migrated production PostgreSQL environment. Existing stage DB/Redis cannot be
used for it. No finance endpoint is mounted in RC7. No new host service or
`.env` on Kali is created by this PR.

## Isolated locked runtime preview (not a checkout)

This RC8 branch includes `src/live/server.ts`, a loopback-only,
readiness-negative HTTP probe (port `18290`) for independent process
verification on Kali. It has **no** buyer checkout, money-write,
transfer or refund routes. Its `/api/v1/ready` intentionally returns HTTP
503 and `productionReady:false`. No Cloudflared or PM2 change is made.

To start this temporary QA probe after installing the pinned RC8 source,
run as `tala-node-stage` from `node-backend`:

```bash
NODE_ENV=production RC8_LIVE_CHARGES_ENABLED=false \
 RC8_LIVE_TRANSFERS_ENABLED=false RC8_LIVE_REFUNDS_ENABLED=false \
 node dist/live/server.js
```

Probe via another local terminal only:
`curl -sS http://127.0.0.1:18290/api/v1/health`
and
`curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:18290/api/v1/ready`
(the latter must be HTTP 503). Use Ctrl+C to shut down this test process.
It must not be placed behind the public Cloudflared tunnel or substituted
for RC7; it does not exercise a production DB or Stripe LIVE.

## Next Kali release: code-only installation (no PM2 cutover)

RC8 includes **two** safe operator scripts under `node-backend/scripts/`:

- `rc8-kali-install-candidate.sh --prepare <FULL_RC8_SHA>`: pins a specific
  reviewed commit from the RC8 branch, clones to its own
  `~/tala-node-releases/<SHA>` directory, runs frozen npm dependencies,
  Prisma generate/schema validate, strict TypeScript and all unit tests.
  Does **not** migrate a database, restart PM2, change Cloudflared or use
  Stripe LIVE API. Requires current RC7 PM2 to remain the reviewed SHA.
- `rc8-kali-next-deployment-preflight.sh --plan <FULL_RC8_SHA>`: validates
  the SHA, paths, code gate, current RC7 PM2 identity, financial-writes OFF
  and local/public health. Does not display secrets or mutate services.

Do not claim the above constitutes Stripe LIVE production deployment:
it installs **reviewable code** in a separate directory only. The operational
rollout will require its own production entrypoint, authenticated API,
persistent queue/worker, refund/chargeback compensation, Connect, PaymentSheet,
independent PostgreSQL/Redis, full TEST and pilot LIVE approval.

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
