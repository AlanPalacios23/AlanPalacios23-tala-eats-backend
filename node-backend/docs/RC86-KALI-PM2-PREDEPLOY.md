# Tala Eats RC8.6 — Candidate for Kali PM2 (not yet deployed)

## Concrete fixes in RC8.6
- Stripe node v23 API 2026-09-30.endive: create LIVE PaymentIntent with `allowed_payment_method_types: ['card']` only; never send removed `payment_method_types` or mix with `automatic_payment_methods`. Confirmed against current Stripe support documentation.
- Restaurant owner transitions `received -> confirmed -> preparing -> ready` and pickup PIN completion now accept `stripe_live_payment` / `stripe_live_collected` **only in gated NODE_ENV=production** and only if exact order id, amount, credit direction and immutable ledger key match. TEST and LIVE records are never interchangeable.
- Read-only Stripe readiness verifies independently approved merchant-owned Connect accounts from isolated production PG. Not a single platform operator's Express account. At least one seller must be fully active, while other stores remain held at checkout until verified.
- `scripts/rc86-kali-prepare.sh` and `scripts/rc86-kali-readonly-preflight.mjs`: prepare and inspect exact pinned SHA with Node24; prevent accidental public PM2, Redis, DB migrations or money writes during preparation. Never echo secrets.
- Automated regression suite `tests/rc86-live-pickup-fulfillment.test.mjs` protects the code paths and Stripe SDK parameters; continue to run the full Node PG15/Redis8 CI.
- Production `/api/v1/health` identifies candidate `rc8.6-live-pickup-finance-review` after actual PM2 promotion.

## Deployment scope
**Same PM2 API** `tala-node-stage-api` at `127.0.0.1:18190` behind existing Cloudflare domain, plus existing `tala-node-stage-worker` switching to `dist/live/production-worker.js`. No Docker, no second listener. Keep secrets only in `/home/tala-node-stage/.config/talaeats-node-live.env` service-owned `0600`.

RC8.6 candidate supports the **code paths** for card pickup and finance review. True card charges remain dependent on accounts, approved LIVE keys, KYC, webhooks, audited ledger/worker, and operator activation. Delivery orders using real Tala Eats drivers and automated Connect transfers are **not production-enabled**; those require additional QA and launch gates. Do not pretend to launch full restaurant/driver delivery when the current driver code is still synthetic.

## Phase 1: source preparation ONLY (safe when live switches are false)
1. Clone/fetch the connected GitHub branch into `/home/tala-node-stage/tala-node-releases/<EXACT_COMMIT_SHA>/`, pin the SHA and keep this checkout clean. Never reuse the mutable active working directory for a production compilation.
2. As `tala-node-stage`, use `python3 scripts/kali-rc83-live-env-wizard.py` if its private LIVE configuration file is not yet populated. Enter secrets in the invisible prompts on Kali, NEVER into chat. If the file exists, verify it is owned by the service and 0600.
3. In the SHA directory under `node-backend`, run `bash scripts/rc86-kali-prepare.sh <EXACT_COMMIT_SHA>`.
4. PASS means **build and source ready**, not production live. Scripts neither run `pm2 reload`, `prisma migrate deploy`, nor `stripe.transfers.create`; they explicitly require live financial switches to remain `false`.

## Phase 2: external prerequisites for the real operator GO
- A verified restoration test for a fresh, **dedicated production PostgreSQL** backup and a Redis recovery procedure; validate migrations RC8.4 and RC8.5 against the selected production database with staging completely isolated.
- Reconcile merchant ownership/Connect onboarding per restaurant, verify account country MX, transfers active, payouts enabled, and registered owner consent. Initial Express account with missing KYC does not qualify.
- Verify the Stripe Dashboard webhook configured at `https://talaeats.alan-palacios-dev.com/api/v1/payments/stripe/webhook` subscribes to PaymentIntent, refund, refund.failed, charge.refunded, dispute.created and dispute.closed; verify signature with a real LIVE event under authorized control.
- Test a small, explicitly authorized LIVE charge and a refund; prove immutable ledger, no duplicate credit on replay, no orphaned PI, order PIN proof, inventory stock and authenticated owner. Get approval for actual financial activity before initiating.
- Confirm Flutter **Usuarios** published version supports live PaymentIntent flow; test Restaurant owner pickup path and driver side separately. Mobile PR #62 remains draft until its version is released.
- Once all pass, schedule the **single** promotion into the existing public PM2 API and worker, with source pinned, backup, rollback playbook and real postdeploy audit. Do not create separate services.

## Hard release gates
- This branch should remain a DRAFT PR until CI 4/4 PASS on the frozen SHA and human validation of live prerequisites.
- `npm run release:production:check` intentionally returns PRODUCTION_NO_GO; do NOT flip that source file just to green-light payments.
- **No manual or automatic restaurant/driver transfer execution has been enabled.** A Stripe transfer to Connect is not a bank deposit.
- **No cash balance is considered remitted to Tala Eats** merely because a merchant or driver uploaded evidence; actual bank settlement requires external reconciliation.
- If the release is promoted and a reconciliation error occurs, BLOCK new charges and preserve original receipts/worker-ledger; don't erase the evidence by rolling back the DB.

## Relevant source references
- Backend PR #139: https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/pull/139
- Flutter PR #62: https://github.com/AlanPalacios23/tala-eats-mobile/pull/62
- Stripe Endive payment-method migration: https://support.stripe.com/questions/fix-the-payment-method-types-error
