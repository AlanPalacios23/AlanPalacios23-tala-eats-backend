#!/usr/bin/env bash
# RC8.6 Kali release compiler — no systemctl, PM2, database, Stripe or tunnel writes.
# Run only as the existing service account; accepts exactly one immutable SHA.
set -euo pipefail
umask 077
if [[ $# -ne 1 || ! "$1" =~ ^[a-f0-9]{40}$ ]]; then
  echo "USAGE: rc86-kali-prepare.sh <EXACT_40_CHAR_SHA>" >&2
  exit 2
fi
if [[ "$(id -un)" != "tala-node-stage" || "$(id -u)" == "0" ]]; then
  echo "RC86_SERVICE_USER_REQUIRED" >&2
  exit 1
fi
SHA="$1"
BASE="/home/tala-node-stage/tala-node-releases/$SHA"
ROOT="$BASE/node-backend"
if [[ ! -d "$ROOT" || -L "$ROOT" || -L "$BASE" || ! -f "$ROOT/package-lock.json" ]]; then
  echo "RC86_SOURCE_DIRECTORY_NOT_PREPARED" >&2
  exit 1
fi
if [[ "$(git -C "$BASE" rev-parse HEAD)" != "$SHA" ]]; then
  echo "RC86_SOURCE_SHA_MISMATCH" >&2
  exit 1
fi
if [[ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]]; then
  echo "RC86_NODE_24_REQUIRED" >&2
  exit 1
fi
cd "$ROOT"
npm ci --ignore-scripts --no-audit --no-fund
# Prisma generate/validate are schema-only. Never feed LIVE credentials to
# a compiler or tests; this URL points to an intentionally nonexistent port.
SCHEMA_ONLY_DATABASE_URL='postgresql://rc86_offline:rc86_offline@127.0.0.1:65534/rc86_never_connect'
DATABASE_URL="$SCHEMA_ONLY_DATABASE_URL" npm run generate
DATABASE_URL="$SCHEMA_ONLY_DATABASE_URL" npm run db:validate
npm run build
npm test
node scripts/rc86-kali-readonly-preflight.mjs "$SHA"
printf '%s\n' \
  'RC86_KALI_RELEASE_CODE_PREPARED=PASS' \
  'RC86_PM2_PUBLIC=UNCHANGED' \
  'RC86_STRIPE_LIVE_CHARGES=OFF' \
  'RC86_DATABASE_MIGRATION=NOT_APPLIED' \
  'RC86_LIVE_DEPLOY_REQUIRES_SEPARATE_OPERATOR_APPROVAL'
