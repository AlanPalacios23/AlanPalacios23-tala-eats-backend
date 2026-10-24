#!/usr/bin/env bash
# OPTIONAL stage-schema gate if RC8.11 plan reports pending PG15 Prisma migrations.
# Standalone explicit approval required. Never runs on production PG18.
set -Eeuo pipefail
set +x
umask 077
if [[ "$#" -lt 2 || "$#" -gt 3 ]]; then
 echo 'USAGE: bash scripts/rc811-stage-schema-gate.sh --plan|--apply SHA [I_APPROVE_RC811_PG15_STAGE_SCHEMA_ONLY]'
 exit 2
fi
MODE="$1"; SHA="$2"; APPROVAL=''
if [[ "$#" == 3 ]]; then APPROVAL="$3"; fi
[[ "$MODE" == '--plan' || "$MODE" == '--apply' ]] || exit 2
[[ "$SHA" =~ ^[a-f0-9]{40}$ ]] || { echo 'RC811_FULL_SHA_REQUIRED'; exit 2; }
[[ "$(id -un)" == 'tala-node-stage' && "$(id -u)" != 0 &&
 "$HOME" == '/home/tala-node-stage' ]] || { echo 'RC811_STAGE_USER_REQUIRED'; exit 1; }
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
ROOT="$HOME/tala-node-releases/$SHA"
WORK="$ROOT/node-backend"
[[ -d "$WORK" && ! -L "$ROOT" && ! -L "$WORK" &&
 "$(cd "$(dirname "$0")/.." && pwd -P)" == "$WORK" &&
 "$(git -C "$ROOT" rev-parse --verify HEAD)" == "$SHA" &&
 -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]] ||
 { echo 'RC811_PINNED_CLEAN_STAGE_SOURCE_REQUIRED'; exit 1; }
cd "$WORK"
ENV="$HOME/.config/talaeats-node-staging.env"
[[ -f "$ENV" && ! -L "$ENV" &&
 "$(stat -c '%a' "$ENV")" == '600' &&
 "$(stat -c '%u' "$ENV")" == "$(id -u)" ]] ||
 { echo 'RC811_STAGE_ENV_REQUIRED'; exit 1; }
# Independently check the identity of the active server and planned database.
bash scripts/kali-stage-first-release-preflight.sh --plan
bash scripts/kali-stage-migrate.sh --preflight
python3 scripts/kali-stage-migration-static-audit.py --check
if [[ "$MODE" == '--plan' ]]; then
  if node --env-file="$ENV" ./node_modules/prisma/build/index.js migrate status; then
    echo 'RC811_PG15_MIGRATIONS=ALREADY_APPLIED'
  else
    echo 'RC811_PG15_MIGRATIONS=NEED_MANUAL_APPROVAL'
  fi
  echo 'RC811_STAGE_SCHEMA_PLAN_READ_ONLY=PASS'
  exit 0
fi
[[ "$APPROVAL" == 'I_APPROVE_RC811_PG15_STAGE_SCHEMA_ONLY' ]] || {
 echo 'RC811_PG15_SCHEMA_MUTATION_NOT_APPROVED'; exit 2;
}
# Back up the same guarded PG15 db, prove scratch restoration FIRST.
TALA_STAGE_BACKUP_APPROVAL=I_APPROVE_STAGE_DB_BACKUP_ONLY \
 python3 scripts/kali-stage-backup.py --apply
TALA_STAGE_RESTORE_APPROVAL=I_APPROVE_ISOLATED_STAGING_RESTORE_TEST \
 python3 scripts/kali-stage-test-restore.py --apply
# No automatic rollback of database schema. Review migration compatibility
# with the currently running stage build BEFORE approving --apply.
TALA_STAGE_MIGRATE_APPROVAL=I_APPROVE_NEW_STAGE_SCHEMA_ONLY \
 bash scripts/kali-stage-migrate.sh --apply
node --env-file="$ENV" ./node_modules/prisma/build/index.js migrate status
echo 'RC811_PG15_STAGING_SCHEMA_APPLIED_AND_VERIFIED=PASS'
echo 'RC811_PM2_AND_STRIPE_LIVE=UNCHANGED'
