# Tala Eats Node.js — functional readiness audit (20 Oct 2026)

> Not a claim of full Python parity or production readiness.
> Scope: **real Node stage on Kali** with isolated PostgreSQL 15, Redis 8 and PM2, `https://api-stage-talaeats.alan-palacios-dev.com/api/v1`.
> Baseline deployed to Kali before this branch: `a39b93b6963d423ee71f1e47d652d9d4dda0f1a5`.

## Observed defects from real Flutter apps and source

| Area | Finding | Current branch |
|---|---|---|
| Restaurante onboarding | Node rejected its own canonical onboarding document URL | PR #108 checks upload owner, random filename and DB media ownership |
| Restaurante media | Flutter requires same-host absolute HTTPS, Node returned relative path | PR #108 returns trusted HTTPS and supports legacy URLs |
| Usuarios recovery | Outbox queued mail, no sender; token link used 127.0.0.1 | PR #108 opts in allowlisted real sender; fail-closed without provider; use Android HTTPS App Link |
| Usuarios cash pickup | Flutter sends neutral coupon/coordinates that strict Node endpoint rejected | This branch accepts exact neutral fields; rejects discounts/delivery; HMAC idempotency preserved |
| Payment choices | API advertised cash enabled even with stage checkout flag false | This branch reflects actual flags and keeps Stripe off |
| Owner authorization | Owner could mark own listing sponsored | This branch requires admin |
| Upload durability | Default media in /tmp not persisted/covered by Kali's /home/tala-node-stage/media backup | This branch defaults media to service home on Kali, reads-through legacy /tmp objects |
| Media abuse | Upload endpoint had bounded 5 MB per request but no account rate budget | This branch restricts 120 attempts per account per hour using Redis, fail-closed |

## Actual capability, not route count

| Capability | Runtime status | What must happen next |
|---|---|---|
| Registration, login, bearer auth and device sessions | Implemented in isolated Node staging with rate limiting | Real-device E2E including expired session and OTP |
| Restaurant onboarding + ADMIN approval | Corrected contracts; CI-tested on disposable infrastructure | Deploy stage fix, provision/secure admin identity and exercise full onboarding on phone |
| Restaurant profile, catalog, KDS | Implemented basic routes; approval and role-specific checks | E2E with media, opening shop, menu CRUD and actual order |
| Users discover/catalog | Node HTTPS GET 200 proven | Verify all JSON fields and images from APK |
| Cash/pickup order | Atomic implementation **only** if `STAGE_PICKUP_CASH_CHECKOUT_ENABLED=true` | Stage opt-in and two-device E2E; never use actual cash funds while stage |
| Cash/delivery through Driver | Driver mutations operate on **synthetic driver fixtures**, normally flag disabled | Implement genuine cash/delivery creation, dispatch and accounting before enabling |
| Stripe payment/reconciliation/refunds | Disabled intentionally (`STRIPE_FINANCIAL_WRITES_ENABLED=false`) | Implement and test complete Stripe TEST webhook, idempotency, ledger, refunds, settlement; financial and security approval before live |
| Recover password email | Resend opt-in + allowlist only; **OFF** until verified sender/secret | Configure provider in Kali secret environment and test delivery + Android app link |
| Push, realtime events, partner settlement | Routes may exist but real delivery/worker/finance parity **not proven** | Integrate transports, workers and E2E against actual clients |
| Admin app and privileged MFA | Node admin routes role-gated; Cloudflare Zero Trust not applied to the stage API | Enforce strong admin MFA and private admin UI before exposing administrative operations |

The Python HTTP inventory structurally matches **249 of 252** declared Node routes (three Mercado Pago endpoints intentionally retired). This is **not** a verification of HTTP results, side effects, payments, security or UI behavior of the 249 declarations. Many routes intentionally return HTTP 503 for missing capabilities.

## Stage rollout controls — no automatic production changes

1. Current GitHub work is on PR #108 and dependent PR #110. CI must pass including PG15/Redis8 disposable integration suites. Neither PR deploys to Kali automatically.
2. Inspect private staging media path `/home/tala-node-stage/media` and preserve any legacy `/tmp/tala-node-stage-media` files with a backup **before** promoting release. Existing relative photo URLs are supported; the backend copies old files on read when possible. The temp directory can be automatically purged by the OS, so do not wait to back it up.
3. Merge reviewed changes to the **existing stage release branch**, then run the stage account's `node-backend/scripts/actualizar.sh --plan`, inspect and run `--apply` with the documented explicit approval. This script checks isolated PG15/Redis8 and performs PM2 rollback if health fails. No `prisma migrate deploy` against production.
4. Verify `/health`, `/ready`, `/restaurants`, and `/orders/payment-methods` through public HTTPS. This does not demonstrate mobile functionality.
5. Only after QA with test accounts, optionally enable **cash + pickup only** via `STAGE_PICKUP_CASH_CHECKOUT_ENABLED=true` on the stage user's mode-0600 env and restart only stage API/worker. Check 15% merchant commission, 7% fee, version-specific cap and exactly-once stock/ledger.
6. Never enable real Stripe settlements or driver cash deliveries from a generic `ready=true`; both need dedicated gates, contract tests and sign-off.
7. Keep ADMIN old production protected and Python Docker unchanged. Avoid storing customer PII, real payment credentials or ID documents in open staging while Zero Trust is deferred.

## CI evidence and limits

Use GitHub Actions `TALA EATS | Stripe Only Kali Staging Candidate PG15 Redis8` on the PR branch to run Node 24, Prisma 7, TS build and existing E2E. Added regressions validate:
- Flutter `_placeOrderOnce` JSON for cash/pickup, retry idempotency, bad coupon and delivery coordinates rejected.
- Media upload owner/foreign path (PR #108); public catalog absolute HTTPS.
- Sponsorship change rejected for merchant.
- Payment methods respect real stage feature flag.

**Pending before real-world launch:** on-device API contract test matrix for all three apps, environment secrets, domain/mail ownership, controlled Stripe TEST finance flows, delivery accounting, real support workflows, MFA, rollback drill and security review.
