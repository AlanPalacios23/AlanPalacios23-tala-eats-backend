# Tala Eats — Backend security review RC9.3 (2026-10-28)

Scope: Node.js API, PostgreSQL financial data, Stripe LIVE / Connect, wallet and
bank onboarding for Restaurants and Drivers, authentication, signed webhooks,
worker, and production-release gates. This is **not** a certification that every
API route has been security-reviewed, nor permission to send money.

## Baseline verified
- Last operator-confirmed Kali LIVE commit: `8f4ea97c23ae8372d171f277f5615c719beed240`.
- Prisma Treasury RC9 six-table migration, two PM2 processes, LIVE checkout,
  and `/api/v1/ready` were confirmed by operator logs.
- Previous encrypted LIVE backup was restored in a shadow database and the
  Treasury migration tested there. A **new pre-RC9.3 backup** is still required.
- New RC9.2 browser return page was committed, but **not confirmed deployed**.
- All RC9.3 changes live on a draft PR and have not changed production.

## Findings and remediations in PR #163

| Priority | Finding | Fix | Status |
|---|---|---|---|
| P0 | Restaurant legacy bank-onboarding link lacked fresh TOTP | Authenticate active owner, rate-limit and consume TOTP, verify Stripe owner email before issuing link | Code patched, CI required |
| P0 | Driver legacy bank-onboarding link used Boolean TOTP but not durable shared attempt accounting | Reuse same distributed step-up and owner-identity check | Code patched, CI required |
| P0 | Legacy Restaurant/Driver owner confirmation could proceed without fresh TOTP | Require fresh TOTP and re-read live mapping/owner identity | Code patched, CI required |
| P0 | Admin Connect-account mapping trusted an old MFA session | Require a newly supplied TOTP for each mapping | Code patched, CI required |
| P0 | Bank TOTP could be reused within its accepted 30-second counter | Add unique `(user_id,otp_counter)` PostgreSQL consumption table and atomic insert; never store OTP | New additive migration, CI required |
| P1 | Errors for invalid/replayed/rate-limited banking OTP were masked by broad 503 responses | Return explicit 403 or 429 while keeping Stripe/DB failures closed | Code patched |
| P1 | Dependency CVEs had no blocker in Treasury CI | Add production-dependency npm HIGH/CRITICAL audit | CI added |

## Other critical gaps — **not fixed by this PR**
1. **No money release**: `NODE_TREASURY_LIVE_EXECUTION_ENABLED=false` remains a
   source-level kill switch. Stripe Connect transfers / payouts are not live.
2. Connected-account webhook `/api/v1/webhooks/stripe-connect` was absent in
   Stripe LIVE at last audit. Until separate Connect signing secret, signature
   verification, delivery, replay and reconciliation are demonstrated, it is
   unsafe to accept or mark bank deposits paid.
3. No successful full Stripe TEST lifecycle has yet been demonstrated for
   a restaurant and a driver: delivered order, captured source charge, transfer,
   connected available funds, bank payout and signed terminal event.
4. Last audit had only 1 restaurant mapping, 0 driver mappings, and 1
   administrator with MFA; Treasury requires two **different** administrators.
5. The existing account uses automatic Stripe payout schedule, whereas manual
   wallet withdrawal requires a separately approved and tested schedule policy.
6. One old Stripe transfer lacked a `source_transaction`; do not import it
   into the new ledger or count it as a customer-funded balance without
   independent reconciliation.
7. Status endpoints call Stripe on demand; implement provider-budget-aware
   throttling and caching only if proven necessary under load (never cache
   withdrawability across a balance change).
8. Flutter / legacy clients that previously confirmed Connect owner identity
   without a fresh TOTP need an API contract update before merging this PR.
9. RC9.2 Stripe return UX still requires a separate LIVE deployment; manual
   return from Chrome is not bank-identity proof.

## Required quality gates
- TypeScript `npm run build` and full backend unit suite.
- `npm audit --omit=dev --audit-level=high`.
- PostgreSQL 15 migration from an empty, isolated CI database.
- Real concurrent PostgreSQL TOTP replay test in
  `scripts/ci-rc93-connect-otp-replay-pg15.mjs`.
- LIVE credential isolation, signed webhook, payments and worker regression
  workflows all PASS, without modifying Stripe or Kali.
- Preproduction tests of both the new and old Connect routes for
  401/403/409/429, stale OTP, role/owner mismatch and account changes.
- Encrypted **fresh** LIVE backup + independent recovery validation before
  applying RC9.3 migration in Kali.

## Production upgrade order (not executed)
1. Freeze reviewed commit SHA, complete the PR's CI and QA.
2. Backup `tala_node_live` from port 15445 (never point to staging), encrypt
   and verify recovery on a throwaway database.
3. Review exact Prisma ledger and check **only** RC9.3 migration pending;
   apply additive `20261028_rc93_connect_otp_replay_hardening` with approval.
4. Install compiled API/worker with existing two-process PM2 configuration,
   bounded readiness checks and rollback to the current `8f4ea97...` LIVE.
5. Confirm Stripe LIVE customer checkout and webhook remain operational;
   route tests must not create any Connect payout or transfer.
6. Confirm banking routes reject missing, invalid and reused TOTP;
   update old client contracts where necessary.
7. Keep actual withdrawal flags **OFF** pending Stripe TEST and dual-approval
   certification.

Do not treat a successful code build, a connected bank, a webhook landing
page or an existing platform Stripe balance as a completed bank payout.
