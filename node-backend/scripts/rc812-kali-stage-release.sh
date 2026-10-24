#!/usr/bin/env bash
# RC8.12 stage-only deploy entrypoint: pinned SHA, no LIVE charge authorization.
# PREPARE and PLAN cannot mutate PM2, PostgreSQL or Cloudflared.
# APPLY delegates to the existing backed-up PM2 cutover.
set -Eeuo pipefail
set +x
umask 077
if [[ "$#" -lt 2 || "$#" -gt 3 ]]; then
 echo 'USAGE: bash scripts/rc812-kali-stage-release.sh --prepare|--plan|--apply|--verify FULL_SHA [I_APPROVE_RC812_STAGE_PM2_ONLY]'
 exit 2
fi
MODE="$1"; SHA="$2"; APPROVAL=''
if [[ "$#" -eq 3 ]]; then APPROVAL="$3"; fi
[[ "$MODE" =~ ^--(prepare|plan|apply|verify)$ && "$SHA" =~ ^[a-f0-9]{40}$ ]] || {
 echo 'RC812_ABORT=INVALID_MODE_OR_SHA'; exit 2;
}
[[ "$(id -un)" == 'tala-node-stage' && "$(id -u)" != 0 &&
   "$HOME" == '/home/tala-node-stage' ]] || {
 echo 'RC812_ABORT=STAGE_USER_REQUIRED'; exit 1;
}
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
ROOT="$HOME/tala-node-releases/$SHA"
WORK="$ROOT/node-backend"
[[ -d "$WORK" && ! -L "$ROOT" && ! -L "$WORK" &&
   "$(cd "$(dirname "$0")/.." && pwd -P)" == "$WORK" &&
   "$(git -C "$ROOT" rev-parse HEAD)" == "$SHA" &&
   -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]] || {
 echo 'RC812_ABORT=PINNED_CLEAN_RELEASE_REQUIRED'; exit 1;
}
cd "$WORK"
[[ -f src/runtime-readiness.ts && -f src/stage-worker-gate.ts &&
   -f tests/rc812-runtime-readiness.test.mjs ]] || {
 echo 'RC812_ABORT=WORKER_ADMISSION_GUARDS_MISSING'; exit 1;
}
if [[ "$MODE" == '--prepare' ]]; then
  bash scripts/rc811-kali-stage-candidate.sh --prepare "$SHA"
  bash -n scripts/kali-stage-first-pm2-promote.sh
  bash -n scripts/rc812-kali-stage-release.sh
  echo 'RC812_BUILD_AND_TEST_PREPARED=PASS'
  echo 'RC812_DB_PM2_TUNNEL_UNCHANGED=YES'
  exit 0
fi
if [[ "$MODE" == '--plan' ]]; then
  bash scripts/rc811-kali-stage-promote.sh --plan "$SHA"
  echo 'RC812_STAGE_DEPLOYMENT_PLAN_READ_ONLY=PASS'
  exit 0
fi
if [[ "$MODE" == '--verify' ]]; then
  bash scripts/rc811-kali-stage-promote.sh --verify "$SHA"
  echo 'RC812_STAGE_POSTDEPLOY_READ_ONLY=PASS'
  exit 0
fi
[[ "$MODE" == '--apply' && "$#" -eq 3 &&
   "$APPROVAL" == 'I_APPROVE_RC812_STAGE_PM2_ONLY' ]] || {
 echo 'RC812_ABORT=EXPLICIT_STAGE_PM2_APPROVAL_REQUIRED'; exit 2;
}
# RC811 promoter rechecks exact environment, migration status, PM2 source and
# backup/restoration before cutover. RC812 fixes worker-first start/rollback.
bash scripts/rc811-kali-stage-promote.sh --apply "$SHA" I_APPROVE_RC811_STAGE_PM2_ONLY
echo "RC812_STAGE_ACTIVE_SHA=$SHA"
echo 'RC812_STRIPE_LIVE_PAYOUTS=NOT_ENABLED'
echo 'RC812_COMMERCIAL_LAUNCH_APPROVED=NO'
