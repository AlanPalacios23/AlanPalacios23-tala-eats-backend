# TALA EATS — RC7 Kali staged deployment gates

**Release target: TEST/STAGING ONLY. This document is NOT an authorization to activate payments LIVE.**
Source PR: [Backend RC7 #133](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/pull/133). Flutter contract PR: [Mobile RC7 #61](https://github.com/AlanPalacios23/tala-eats-mobile/pull/61).

## Baseline to preserve

- Keep the publicly routed RC6 API on `https://talaeats.alan-palacios-dev.com/api/v1` until a reviewed rollback strategy is approved.
- The existing stage API was observed on `127.0.0.1:18190`, stage PostgreSQL on `127.0.0.1:15435` and Redis on `127.0.0.1:16379`; **read the current host config and verify** before any operation. No assumption about systemd unit names or process layout is made.
- Do not modify Cloudflared routes or CODEXIA, DATECLUB, NOCTRA or other production services.
- Legacy Python `talaeats-v3` containers were removed intentionally; **the 5 volumes and backup directory under /home/alan/talaeats-legacy-backups must not be deleted**. Old data migration was not established by the container cleanup.

## Phase 0 — independent release evaluation

1. Verify source review, branch/commit SHA, public diff, secrets scan and tests:
   - `npm ci`, `npm run generate`, `npm run build`, `npm test`, route parity and disposable PG/Redis CI suites.
   - Confirm all checks succeed for the **same exact candidate SHA**, not an earlier PR or branch.
   - Confirm Flutter Usuarios and Restaurantes/Repartidor PR checks for the related mobile SHA. A passing users-only build does **not** validate the other apps.
2. `node scripts/release-readiness.mjs --stage --json` is a source gate, **not** Stripe readiness proof. `--production` must remain **NO-GO**.
3. Inspect the actual host version, health, backups and ACLs without printing secrets. Run `bash scripts/rc7-kali-finance-preflight.sh` as `tala-node-stage` while all payment flags remain OFF. It checks both local and public API, DB/Redis/worker heartbeat, TEST-only flags and a private 0600 environment file. Does not require guessed service unit names.
4. Record PM2 process names, actual PostgreSQL/Redis instance ownership and Cloudflared routing from existing host configuration. No restarts before inventory and rollback proof.

## Phase 1 — backups and isolated candidate

- Snapshot the actual **Node staging** PostgreSQL before schema changes; backup must be readable with `pg_restore -l` and must be test-restored to a **separate disposable database**. Verify owner/permissions and preserve old backup off-host if possible.
- Backup relevant stage assets, Redis queue state and the previous PM2 release manifest/commit. Keep archive paths private and do not commit credentials.
- Prepare RC7 from the **pinned reviewed SHA** in a separate release directory under the stage account. Do not edit the PM2 live directory in place. Schema differences must be reviewed and migration dry-run or tested on the restored disposable DB.
- Run `npm ci`, Prisma generation/schema validation, build and the stage-safe readiness checks from the candidate. Verify it cannot accept `NODE_ENV=production`, `sk_live_` or `rk_live_`.

## Phase 2 — only Stripe TEST, never financial LIVE

1. Create a separate Stripe sandbox (or existing isolated TEST environment). Restrict API permissions and IP policy where feasible; prefer `rk_test_` over `sk_test_` if compatible with retrieve Events/PaymentIntents and create/cancel PaymentIntent.
2. Execute **only after phase 1 passes**: `bash scripts/kali-stripe-test-secret-wizard.sh --plan` and then, with the operator present, `--apply` as `tala-node-stage`. Enter keys through hidden local terminal; no keys in chat, logs, files committed to GitHub or mobile binaries. The wizard **does not enable checkout**.
3. Validate the Stripe webhook signing secret from the correct sandbox and public endpoint. Verify signature, replay and unique event IDs; never trust mobile callback as proof of payment.
4. Test signed webhooks with successful/declined/3DS test cards, concurrent duplicate events, out-of-order events and complete inventory/ledger consistency. Verify cancellation, delayed events and 35-minute conservative expiry without returning stock if Stripe could have charged.
5. Verify TEST earnings snapshots exclude refunded orders and charges missing an immutable Stripe receipt. They must always show `available_for_withdrawal='0.00'`, `eligible=false`, `reconciliation_hold=true` regardless of illustrative historical earnings.

## Extra mandatory finance gate (read only)

After creating the isolated stage candidate and loading its private stage-only env, execute in the candidate's `node-backend` directory:

```bash
npm run finance:stage:gate
```

This command **never** contacts Stripe, captures a payment, initiates a payout, alters the database or prints orders/customer IDs. It reports aggregate counters only. A nonzero exit code stops the deployment/activation decision:

- `stuckIntentReservations`: the database still has PaymentIntent creation reservations older than 10 minutes. Never release their inventory until provider state has been reconciled.
- `overdueUnpaidCardOrders`: unpaid Stripe TEST reservations older than 35 minutes (expiry requires provider confirmation, not a timer-only write).
- `unreconciledSignedWebhooks`: signed payment events older than 15 minutes still `RECEIVED`/`FAILED`. Retry/reconcile before further checkout.
- `paidOrdersMissingTrustedReceipt`: a Stripe order says paid but has no exact matching immutable ledger receipt; do not treat it as paid to a seller.
- `cardCashMisclassification`: a Stripe card order mistakenly records a positive physical cash collection.
- `paidOrderSampleTruncated`: more than 5,000 paid card orders need an independently paginated audit; do not silently classify a truncated subset as clean.

The stage gate may legitimately HOLD an environment that has unresolved TEST fixtures. The resolution is **reconciliation and documented operator review**, never deleting rows to make a counter disappear. It is not a LIVE launch gate and does not substitute a Stripe Dashboard reconciliation, restore test, PaymentSheet E2E or a signed-off payments release.

## Phase 3 — reversible stage cutover

- Require operator confirmation and comparison of local/public `/ready` before any cutover.
- Snapshot the prior PM2 process definition and release files; run new release with the same user/perms, then confirm readiness with DB, Redis and worker Online plus contracts against **test fixtures**.
- If anything regresses, revert to the prior pinned PM2 release and its compatible DB schema. **Never attempt destructive automatic rollback of a DB migration without a proven forward-compatible restoration plan.**
- Recheck all public paths and verify unrelated Kali services, Cloudflared routes and secrets remain unchanged.

## Nonnegotiable NO-GO for commercial activation

**This RC7 only implements a TEST pickup/card slice**, not LIVE deliveries. It cannot be made live by merely pasting `sk_live_` or `rk_live_` in the file.

Before cash/card commercial checkout and all three apps operate in production, implement and validate: cash on delivery and reconciliation with driver; signed real Stripe payments with idempotent refunds/chargebacks and ledger reversals; Stripe Connect Accounts v2 onboarded/verified recipients, transfer scheduling and disputes; actual seller and driver payout limits; REST/mobile UI PaymentSheet and receipts; exact final Mexican fees, tax and commercial conditions; secret manager/rotation; observability and emergency financial stop controls; a performed restore and rollback drill; and a reviewed production authorization.

**Do not delete the legacy five volumes, backup archives, active RC6 code or unrelated Kali projects to make room for this RC7 candidate.**
