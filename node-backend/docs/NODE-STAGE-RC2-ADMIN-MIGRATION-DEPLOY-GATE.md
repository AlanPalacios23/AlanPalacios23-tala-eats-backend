# TALA EATS · Node.js staging RC2 · Migration-aware deployment gate

**Deployment status: CANDIDATE FOR MANUAL KALI STAGING ONLY. PRODUCTION COMMERCIAL: NO-GO.**

## Scope
This release adds real ADMIN support tickets / replies / audit notification, MFA-verified admin sessions and reversible-by-operator *logical archive* of inactive restaurants. It retains market-separated public catalog, customer pickup and test-only media. The schema adds two nullable/defaulted columns to `support_tickets` in `prisma/migrations/20261020_admin_helpdesk_reply/migration.sql`.

The previous Python PostgreSQL16 production, Python Docker/Cloudflare routing, payment credentials, and live financial data must remain untouched.

## Why the standard updater is intentionally blocked
`node-backend/scripts/actualizar.sh --apply` compares the target Prisma directory against the actually running PM2 commit. Since this release changes `prisma/schema.prisma` and adds a migration, it returns `ABORT_PRISMA_CHANGE_REQUIRES_REVIEWED_MIGRATION_AND_MANUAL_RELEASE`. **Do not delete or bypass this guard.**

The migration must be reviewed and applied to isolated PostgreSQL15 staging **after** a restorable private backup; then the separate `kali-stage-first-pm2-promote.sh` promotes the candidate with health checks and rollback.

## Manual operator checklist (no commands executed by this PR)

1. Verify both GitHub Actions checks against the exact target commit and review the SQL: only `ALTER TABLE support_tickets ADD COLUMN admin_reply TEXT NOT NULL DEFAULT ''`, `ADD COLUMN responded_at TIMESTAMP(3)`. Avoid applying to Python PostgreSQL16.
2. On Kali as user `tala-node-stage`, verify the active PM2 API/worker and staging `/ready` (including `productionReady=false`). Confirm `/home/tala-node-stage/.config/talaeats-node-staging.env` is 0600, not a symlink.
3. Fetch the fixed, reviewed SHA of this **staging release branch** and create a detached candidate worktree under `/home/tala-node-stage/tala-node-releases/<FULL_SHA>`, preserving the existing PM2 release directory. Build the candidate via `npm ci`, Prisma `generate` and `npm run build` without touching the running API.
4. Review static migration audit (`python3 scripts/kali-stage-migration-static-audit.py --check`) and run `bash scripts/kali-stage-migrate.sh --preflight` from candidate `node-backend/`. This checks ONLY PG15 stage identity.
5. With explicit staging-only approval, run the existing `kali-stage-backup.py --apply` and `kali-stage-test-restore.py --apply` and **confirm both PASS**. Separately back up stage media, including any old `/tmp/tala-node-stage-media` files.
6. Only after restoration succeeds and after inspecting the exact migration, run `TALA_STAGE_MIGRATE_APPROVAL=I_APPROVE_NEW_STAGE_SCHEMA_ONLY bash scripts/kali-stage-migrate.sh --apply` in the candidate directory. If migration fails, STOP; do not restart PM2.
7. Apply `kali-stage-first-pm2-promote.sh --apply <FULL_SHA>` with its documented three explicit stage-only approvals for PM2, PG backup and restore. It redoes preflight/backup/restore, checks Prisma migrate status and starts API then worker. It rolls back PM2 on smoke failure.
8. Verify the API through the public stage HTTPS URL and three Android apps using test-only accounts, uploads and tickets. Exercise ADMIN TOTP, support ticket→reply→notification, merchant archive only after closing/clearing orders, and market catalog. Do not use real payment data.

## Hard stops / rollback
- A missing backup, failed restore, dirty candidate worktree, unexpected PM2 process, unreviewed migration, or any `financialWrites=true` is an immediate STOP.
- A failed API/worker health check should trigger the existing PM2 rollback. Preserve the previous deployment/worktree and backup; adding nullable/defaulted support columns is backward-compatible with the old application schema, but must still be inspected on rollback.
- No `prisma db push`; no force migration; never disable security gates to obtain an HTTP 200.

## Still blocking production cutover
- Full Stripe TEST checkout, signed webhooks→exactly-once ledger, disputes, refunds, reconciliation and Connect settlements are not implemented end-to-end.
- Real customer deliveries + driver dispatch/payout are not validated beyond synthetic fixtures.
- Verified outbound recovery mail and Android App Links, secure Admin publishing, mobile E2E on devices and production-grade monitoring are incomplete.
- `NODE_ENV` remains staging, `HOST=127.0.0.1`, `STRIPE_FINANCIAL_WRITES_ENABLED=false` and `productionReady=false`. **There is no production switch in this release.**
