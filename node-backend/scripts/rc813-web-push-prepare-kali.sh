#!/usr/bin/env bash
# RC8.13 Web Push — private STAGING release prepare and read-only plan.
# NEVER starts PM2, modifies Stripe/LIVE, or runs Prisma migration deploy.
set -Eeuo pipefail
set +x
umask 077
MODE="${1:---prepare}"
[[ "$MODE" == '--prepare' || "$MODE" == '--plan' ]] || {
 echo 'PUSH_STAGE_ABORT=USAGE_PREPARE_OR_PLAN'; exit 2;
}
[[ "$(id -un)" == 'tala-node-stage' && "$HOME" == '/home/tala-node-stage' ]] || {
 echo 'PUSH_STAGE_ABORT=RUN_AS_TALA_NODE_STAGE'; exit 1;
}
for cmd in git python3 bash curl; do
 command -v "$cmd" >/dev/null || { echo "PUSH_STAGE_ABORT=MISSING_$cmd"; exit 1; }
done
REPO='https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend.git'
# CI-validated commit from isolated backend PR #160, not a moving branch.
SHA='398b531c4778a03975f30470f6979a38b9c8bb62'
RELEASES="$HOME/tala-node-releases"
ROOT="$RELEASES/$SHA"
STAGING_PM2="$HOME/.pm2-tala-rc813-parallel"
DIAG="$ROOT/node-backend/scripts/rc813-web-push-stage-readonly.py"
RUNNER="$ROOT/node-backend/scripts/rc813-parallel-stage.sh"
TMP=''
cleanup(){
 if [[ -n "$TMP" && -d "$TMP" ]]; then rm -rf -- "$TMP"; fi
}
trap cleanup EXIT
[[ ! -e "$STAGING_PM2" && ! -L "$STAGING_PM2" ]] || {
 echo 'PUSH_STAGE_ABORT=PARALLEL_PM2_HOME_EXISTS'; exit 1;
}
[[ ! -L "$RELEASES" ]] || { echo 'PUSH_STAGE_ABORT=RELEASES_IS_SYMLINK'; exit 1; }
[[ -d "$RELEASES" || "$MODE" == '--prepare' ]] || {
 echo 'PUSH_STAGE_ABORT=RELEASE_DIRECTORY_ABSENT'; exit 1;
}
if [[ "$MODE" == '--prepare' && ! -d "$RELEASES" ]]; then
 mkdir -m 700 -p -- "$RELEASES"
fi
[[ ! -L "$ROOT" ]] || { echo 'PUSH_STAGE_ABORT=RELEASE_SYMLINK'; exit 1; }
if [[ ! -e "$ROOT" ]]; then
 [[ "$MODE" == '--prepare' ]] || { echo 'PUSH_STAGE_ABORT=PREPARE_FIRST'; exit 1; }
 TMP="$(mktemp -d "$RELEASES/.incoming-web-push.XXXXXXXX")"
 git -C "$TMP" init -q
 git -C "$TMP" remote add origin "$REPO"
 git -C "$TMP" -c protocol.version=2 fetch --quiet --depth 1 origin "$SHA"
 git -C "$TMP" -c advice.detachedHead=false checkout --quiet --detach FETCH_HEAD
 [[ "$(git -C "$TMP" rev-parse HEAD)" == "$SHA" ]] || {
  echo 'PUSH_STAGE_ABORT=UNEXPECTED_SOURCE_SHA'; exit 1;
 }
 mv -T -- "$TMP" "$ROOT"
 TMP=''
fi
[[ -d "$ROOT" && -d "$ROOT/node-backend" &&
   "$(git -C "$ROOT" rev-parse HEAD)" == "$SHA" &&
   -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" &&
   -f "$DIAG" && -f "$RUNNER" ]] || {
 echo 'PUSH_STAGE_ABORT=RELEASE_IDENTITY_OR_CLEANLINESS'; exit 1;
}
bash -n "$RUNNER"
python3 -c 'import ast,sys;ast.parse(open(sys.argv[1]).read())' "$DIAG"
DIAGNOSTIC="$(python3 "$DIAG")"
printf '%s\n' "$DIAGNOSTIC"
for expected in \
 'LIVE_18190=PRODUCTION_PAYMENT_CAPABLE' \
 'ISOLATED_STAGE_18192=NOT_RUNNING' \
 'STAGE_POSTGRES_15435_SOCKET=OPEN' \
 'STAGE_REDIS_16379_SOCKET=OPEN' \
 'PRIVATE_PARALLEL_STAGE_ENV=VALID' \
 'ISOLATED_PM2_DIRECTORY=ABSENT' \
 'PUSH_PREFLIGHT_COMPLETE=PASS'; do
 if ! printf '%s\n' "$DIAGNOSTIC" | grep -Fxq "$expected"; then
  echo 'PUSH_STAGE_ABORT=ISOLATION_PRECHECK_HOLD'; exit 1;
 fi
done
echo "PUSH_STAGE_PINNED_SHA=$SHA"
if [[ "$MODE" == '--prepare' ]]; then
 echo 'PUSH_STAGE_BUILD_AND_QA=START'
 # Restricted to stage checkout and test DB by existing RC8.13 runner.
 bash "$RUNNER" --prepare "$SHA"
 echo 'PUSH_STAGE_BUILD_AND_QA=PASS'
fi
echo 'PUSH_STAGE_PRISMA_PLAN=START_READ_ONLY'
# Will HOLD if Web Push delivery ledger is pending. NEVER migrate here.
if bash "$RUNNER" --plan "$SHA"; then
 echo 'PUSH_STAGE_PRISMA_PLAN=PASS'
else
 echo 'PUSH_STAGE_PRISMA_PLAN=HOLD_REVIEW_MIGRATIONS_AND_STAGE_DATA'
 echo 'PUSH_STAGE_NO_MIGRATION_EXECUTED=YES'
 echo 'PUSH_STAGE_NO_PM2_START=YES'
 exit 12
fi
echo 'PUSH_STAGE_READY_FOR_SEPARATE_REVIEW=PASS'
echo 'PUSH_STAGE_NO_PM2_OR_LIVE_CHANGES=YES'
