#!/usr/bin/env bash
# Prisma migrate ONLY a verified native PostgreSQL 15 staging database.
# Default --preflight read-only. --apply requires explicit approval.
set -euo pipefail
MODE='--preflight'
if [ "$#" -gt 0 ]; then MODE="$1"; fi
if [ "$MODE" != '--preflight' ] && [ "$MODE" != '--apply' ]; then
  echo 'USAGE --preflight|--apply'; exit 2
fi
if [ "$(id -un)" != 'tala-node-stage' ] || [ "$(id -u)" -eq 0 ]; then
  echo 'ABORT_EXPECTED_STAGE_USER'; exit 1
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT"
ENVFILE="$HOME/.config/talaeats-node-staging.env"
if [ ! -f "$ENVFILE" ] || [ -L "$ENVFILE" ] ||
   [ "$(stat -c '%a' "$ENVFILE")" != '600' ] ||
   [ "$(stat -c '%u' "$ENVFILE")" != "$(id -u)" ]; then
  echo 'ABORT_PRIVATE_CONFIG_MISSING_OR_UNSAFE'; exit 1
fi
if [ ! -s package-lock.json ] || [ ! -f prisma/migrations/migration_lock.toml ]; then
  echo 'ABORT_LOCKFILE_OR_MIGRATIONS_MISSING'; exit 1
fi
if [ ! -x node_modules/.bin/prisma ]; then
  echo 'ABORT_RUN_NPM_CI_BEFORE_MIGRATION'; exit 1
fi
# First perform an identity check without printing any secret or SQL rows.
if ! node --env-file="$ENVFILE" --input-type=module - <<'JS' >/dev/null 2>&1
import pg from 'pg';
const u = new URL(process.env.DATABASE_URL || 'http://invalid');
if (!['postgresql:','postgres:'].includes(u.protocol) ||
    u.hostname !== '127.0.0.1' || u.port !== '15435' ||
    u.username !== 'tala_node_stage' || u.pathname !== '/tala_node_stage' ||
    !u.password || process.env.STRIPE_FINANCIAL_WRITES_ENABLED !== 'false') {
  process.exit(2);
}
const client = new pg.Client({ connectionString: u.href,
  connectionTimeoutMillis: 3000, statement_timeout: 3000 });
try {
  await client.connect();
  const r = await client.query(
    "SELECT current_database() AS db, current_user AS usr, "+
    "current_setting('server_version_num')::int AS ver, "+
    "inet_server_port() AS port"
  );
  const x=r.rows[0];
  if (x.db !== 'tala_node_stage' || x.usr !== 'tala_node_stage' ||
      x.ver < 150000 || x.ver >= 160000 || x.port !== 15435) process.exitCode=3;
} catch { process.exitCode=4; }
finally { await client.end().catch(()=>{}); }
JS
then
  echo 'ABORT_PG15_STAGING_IDENTITY'; exit 1
fi
echo 'NATIVE_PG15_ISOLATION=PASS'
if [ "$MODE" = '--preflight' ]; then
  echo 'MIGRATION_PLAN_ONLY_NO_CHANGES'
  exit 0
fi
if [ "$(printenv TALA_STAGE_MIGRATE_APPROVAL 2>/dev/null || true)" != 'I_APPROVE_NEW_STAGE_SCHEMA_ONLY' ]; then
  echo 'ABORT_EXPLICIT_MIGRATION_APPROVAL'; exit 1
fi
# This modifies ONLY the independently verified stage database.
node --env-file="$ENVFILE" ./node_modules/prisma/build/index.js migrate deploy
echo 'STAGE_PRISMA_MIGRATIONS_APPLIED=PASS'
