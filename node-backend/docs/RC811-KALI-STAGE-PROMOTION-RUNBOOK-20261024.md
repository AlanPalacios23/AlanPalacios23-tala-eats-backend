# Tala Eats RC8.11 — staged rollout on Kali (24 Oct 2026)

STATUS: DRAFT. GitHub Actions success is NOT evidence that a release has been
installed on the user's Kali machine. Python main, live database, Stripe LIVE
and Play Store are deliberately untouched.

Release scope:
- Existing staging account tala-node-stage, not root.
- Existing PM2 stage API and worker on 127.0.0.1:18190, same Cloudflare route.
- Native isolated PostgreSQL 15 on loopback 15435, database tala_node_stage,
  user tala_node_stage; Redis 8 on loopback 16379/0.
- If the actual installed staging database is PostgreSQL 18, HOLD and
  reconcile the configuration; never silently point the app to LIVE.
- Stripe LIVE financial writes/transfers/refunds all disabled. Stripe TEST
  DELIVERY feature stays OFF until a separately authorized signed test.
- Do not use the obsolete branch-locked RC8 candidate installer.

## First step — on Kali as the existing staging account

~~~bash
sudo -iu tala-node-stage
~~~

Replace SHA below with the exact, FINAL 40-character SHA verified in GitHub
after the PR passed. Do not run a moving branch without checking the hash.

~~~bash
set -Eeuo pipefail
SHA="<FINAL_SHA_FROM_GITHUB>"
BRANCH="feat/rc811-kali-stage-release-pipeline-20261024"
REPO="https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend.git"
RELEASE="$HOME/tala-node-releases/$SHA"
test -d "$HOME/tala-node-releases" && test ! -e "$RELEASE"
git clone --depth 1 --branch "$BRANCH" "$REPO" "$RELEASE"
test "$(git -C "$RELEASE" rev-parse --verify HEAD)" = "$SHA"
cd "$RELEASE/node-backend"
bash scripts/rc811-kali-stage-candidate.sh --prepare "$SHA"
bash scripts/rc811-kali-stage-promote.sh --plan "$SHA"
~~~

PREPARE: npm ci, Prisma generate/validate, TypeScript build, Node tests,
source-integrity; only changes the newly cloned candidate, not the active PM2.
PLAN: validates private env permissions (0600), exact SHA, loopback-only
services, PG15 identity, Redis, PM2 ownership, readiness and applied schema.
Both are barred from Stripe LIVE or changing production services.

If plan says PRISMA_MIGRATIONS_PENDING_OR_DIVERGENT or
ABORT_PG15_STAGING_IDENTITY, STOP. Migrations require an independently
approved PG15 backup, restore rehearsal and schema migration before any
promotion. Do not try migration on an unrelated PG18 database.

## Stage-only promotion after the above PASS

The --apply argument is intentional and separate: it DOES change PM2.
It rechecks plan and uses the existing backup/restore-gated promoter, which
can restore the prior PM2 release after a cutover failure (not data reversal).
It never migrates automatically and never enables payments LIVE.

~~~bash
bash scripts/rc811-kali-stage-promote.sh --apply "$SHA" I_APPROVE_RC811_STAGE_PM2_ONLY
~~~

For postdeploy verification without changing anything:

~~~bash
bash scripts/rc811-kali-stage-promote.sh --verify "$SHA"
~~~

Required output markers:
- RC811_PM2_PROMOTION=PASS
- RC89_POSTDEPLOY_READ_ONLY=PASS
- RC811_POSTDEPLOY_READ_ONLY=PASS
- RC811_STAGE_SHA=<exact full SHA>
- RC811_LIVE_PAYMENTS_AND_PAYOUTS=NOT_ENABLED

If the postdeploy audit fails AFTER the promoter, STOP and investigate
orders/receipts before reverting or modifying schemas. Never force flags,
re-run charges, or delete paid orders.

## Real device and payment go-live gates

- Flutter Usuarios/Restaurante/Repartidor Android QA and authenticated
  backend all point at the SAME proven deployed SHA.
- Stripe TEST external PaymentIntent + signed webhook, replay and decline
  handling; synthetic database payment receipt is not sufficient proof.
- Merchant accepts, prepares, marks READY; verified nearby driver
  picks up, transports, PIN-delivers; Stripe prepaid means NO CASH collection.
- Real Firebase foreground/background notifications, GPS permission and
  loss-of-connectivity tests.
- Refund/dispute recovery, actual Stripe fees and merchant/driver balances
  reconciled, Connect onboarding and manual payout audit.
- Signed Play AAB tested; stage success does not permit a commercial launch.

Release is NO-GO for LIVE until these explicit gates are complete.
