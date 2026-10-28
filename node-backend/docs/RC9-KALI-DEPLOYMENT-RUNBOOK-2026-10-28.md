# RC9 Treasury — Kali deployment package (NO MONEY RELEASE)
Date: 2026-10-28. Scope: Node.js backend, restaurant and driver Wallet, additive treasury schema. **No LIVE payout activation.**

## Hard boundary
- Do not replace the existing Node production release from this draft PR. Never deploy Python `main` by mistake.
- Do not set `STRIPE_CONNECT_TRANSFERS_ENABLED=true`, `TREASURY_CONNECT_WEBHOOK_INGEST_ENABLED=true` or change `NODE_TREASURY_LIVE_EXECUTION_ENABLED=false`.
- No automatic Prisma migration against `talaeats_live` and no PM2 restart until operator verifies exact node release, backup and migration plan.
- The source still has a production guard against Connect transfers; this is intentional. A new audited financial release is needed for money movement.
- **No shadow staging with copied LIVE credentials.** Never print passwords, JWTs, webhook secrets, database URLs or bank details.

## 1. Inventory (READ ONLY on Kali)
```bash
set -euo pipefail
date -Is
id
node --version
pm2 list
sudo ss -lntp | grep -E ':(18190|15445|15435)\b' || true
sudo systemctl status cloudflared --no-pager || true
```
Identify the exact running release symlink, Node application user, PM2 ecosystem and existing deployment script BEFORE altering files. Verify the API and worker currently serve the intended instance; do not infer from a public `/ready` alone.

## 2. Freeze and build (off production)
- Review PR #162 and base PR #161; pin a **full 40-character commit SHA**, not a mutable branch.
- Use a clean, unprivileged workspace that has no production `.env`, DB URL or Stripe LIVE key.
- `npm ci --no-audit --no-fund`
- `npm run generate && npm run db:validate && npm run build && npm test`
- `node scripts/rc9-treasury-live-preflight.mjs` — requires `PREDEPLOY_SOURCE_PREFLIGHT=PASS_READ_ONLY` and **`LIVE_WITHDRAWALS_AUTHORIZED=NO`**.
- Require successful Treasury RC9 CI and regression jobs on the SAME SHA.

## 3. PostgreSQL migration dry-run
- Export a schema-only, permission-restricted copy of the live schema and compare against the `20261028_treasury_v1_restaurant_driver` migration.
- Inspect `prisma migrate status`, missing prerequisites, ownership, constraints, lock times, indexes and backfill assumptions in a **separate isolated restore**.
- Take encrypted, access-restricted backup of LIVE PostgreSQL. Verify backup exit code and actual restore into **non-production** before any production write.
- Only after review apply additive migration in a dedicated maintenance window using the existing approved deploy tooling, then verify index uniqueness, consistency and DB revision. Never silently run `migrate deploy` during a web boot.

## 4. Deploy non-spending RC9 (requires explicit maintenance approval)
- Package the verified SHA and checksums; use release-directory + atomic pointer flip + previous pointer for rollback.
- Preserve existing production secrets and financial flags. Do not overwrite ecosystem configuration.
- Restart API and worker in controlled order under the existing service account; run authenticated role-gated Wallet read-only smoke and health/ready checks.
- Confirm `POST /api/v1/withdrawals/restaurant/:id/request` and driver equivalent return **503** while feature is unreleased, and `server_allows_requests=false` on balances. Never send real customer financial POSTs as a smoke test.
- Monitor errors, orphaned events, DB locks, refunds/disputes, ledger consistency and webhook queues. Revert code pointer on regression, but **never blindly roll back an applied additive financial migration or delete ledger rows**.

## 5. Later money activation: separate GO/NO-GO
- Complete real Stripe TEST Connect E2E for both payees; confirm Mexican bank/payout schedules, destination controls, webhooks and API mode.
- Audit durable transfer executor wiring, uncertain transfer recovery, reservation-to-dispatch revalidation, refunds/disputes and manual payout reconciliation.
- Verify dedicated `STRIPE_CONNECT_WEBHOOK_SECRET`, signed inbox delivery, alerting, TOTP/dual review and operational runbook for manual HOLD.
- Obtain explicit financial approval for an independently reviewed release which changes hard-coded financial locks; progressive rollout with strict limits, alerts, reconciliation and instant kill-switch.
- Until then, **Wallet remains read-only** and withdrawal button must stay disabled in both apps.

## Deployment status
At document creation: no Kali execution, no production migration, no financial release. This file is a deployment runbook, **not** proof of deployment.
