#!/usr/bin/env bash
# RC8.14 Pickup LIVE: prepare a pinned backend release separately and replace
# precisely the current payment-capable API + worker using existing backed-up
# RC8.13 promotion. No database migrations, payout changes or Stripe writes.
set -Eeuo pipefail
set +x
umask 077
MODE="${1:-}" SHA="${2:-}" APPROVAL="${3:-}"
if [[ ! "$MODE" =~ ^--(prepare|plan|apply|verify)$ ||
      ! "$SHA" =~ ^[a-f0-9]{40}$ ||
      ( "$MODE" == --apply &&
        ( "$#" -ne 3 || "$APPROVAL" != I_APPROVE_RC814_PICKUP_LIVE_TWO_PM2_ONLY )) ||
      ( "$MODE" != --apply && "$#" -ne 2 ) ]];then
 echo 'RC814_ABORT=USE_PREPARE_PLAN_APPLY_VERIFY_EXACT_SHA_AND_APPROVAL';exit 2
fi
[[ "$(id -un)" == tala-node-stage && "$HOME" == /home/tala-node-stage &&
   "$(id -u)" != 0 ]] || { echo 'RC814_ABORT=SERVICE_USER_REQUIRED';exit 1; }
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
BASE="$HOME/tala-node-releases"
ROOT="$BASE/$SHA"
DIR="$ROOT/node-backend"
ENV="$HOME/.config/talaeats-node-live.env"
OLD=10f28bcaf63efd3e0ab9dc0366440219da261916
if [[ "$SHA" == "$OLD" ]];then echo 'RC814_HOLD=NOT_NEW_RELEASE';exit 1;fi
[[ -f "$ENV" && ! -L "$ENV" && "$(stat -c %a "$ENV")" == 600 &&
   "$(stat -c %u "$ENV")" == "$(id -u)" ]] || {
 echo 'RC814_HOLD=PRIVATE_LIVE_ENV_REQUIRED';exit 1;
}
if [[ "$MODE" == --prepare ]];then
 mkdir -p -m 700 "$BASE"
 [[ ! -L "$BASE" && ! -L "$ROOT" ]] || {
  echo 'RC814_HOLD=RELEASE_DIRECTORY_SYMLINK';exit 1;
 }
 if [[ ! -e "$ROOT" ]];then
  TEMP="$(mktemp -d "$BASE/.pickup-rc814-XXXXXX")"
  cleanup(){ [[ ! -d "$TEMP" ]] || rm -rf -- "$TEMP"; }
  trap cleanup EXIT
  git init -q "$TEMP"
  git -C "$TEMP" remote add origin https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend.git
  git -C "$TEMP" fetch --depth 1 origin "$SHA"
  git -C "$TEMP" checkout -q --detach FETCH_HEAD
  [[ "$(git -C "$TEMP" rev-parse HEAD)" == "$SHA" ]] || {
    echo 'RC814_HOLD=UNEXPECTED_FETCH_SHA';exit 1;
  }
  mv -T -- "$TEMP" "$ROOT"
  trap - EXIT
 fi
fi
[[ -d "$DIR" && ! -L "$ROOT" && ! -L "$DIR" &&
   "$(git -C "$ROOT" rev-parse HEAD)" == "$SHA" &&
   -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]] || {
 echo 'RC814_HOLD=LOCKED_RELEASE_REQUIRED';exit 1;
}
cd "$DIR"
if [[ "$MODE" == --prepare ]];then
 bash scripts/rc813-unified-live-preflight.sh --prepare "$SHA"
 echo 'RC814_PICKUP_LIVE_COMPILED_TESTED_NO_PAYMENT_WRITES=PASS'
 echo 'RC814_PREPARE=PASS'
 exit 0
fi
if [[ "$MODE" == --verify ]];then
 bash scripts/rc813-unified-live-preflight.sh --verify "$SHA"
 node --env-file="$ENV" --input-type=module <<'JS'
import {execFileSync} from 'node:child_process';
for(const origin of ['http://127.0.0.1:18190','https://talaeats.alan-palacios-dev.com']){
 const curl=url=>JSON.parse(execFileSync('curl',['-fsS','--max-time','12',url],{encoding:'utf8',timeout:14000}));
 const cfg=curl(origin+'/api/v1/v11/push/config');
 if(cfg.enabled!==true||!/^B[A-Za-z0-9_-]{80,100}$/.test(cfg.public_key??''))throw Error('WEB_PUSH_UNAVAILABLE');
 const up=curl(origin+'/api/v1/ready');
 if(up.environment!=='production'||up.onlinePaymentsEnabled!==true||up.ready!==true||up.workerOnline!==true)
  throw Error('STRIPE_LIVE_UNAVAILABLE');
}
console.log('RC814_STRIPE_LIVE_AND_WEB_PUSH_PRESERVED=PASS');
JS
 echo 'RC814_PICKUP_LIVE_API_WORKER=PASS'
 exit 0
fi
bash scripts/rc813-unified-live-preflight.sh --plan "$SHA"
# This is a read-only overview; zero merchant approvals is a business HOLD,
# NOT a reason to bypass seller ownership or unset signed webhook protections.
node --env-file="$ENV" scripts/rc814-pickup-readiness-audit.mjs
echo 'RC814_PUBLIC_API_PLAN_AND_MERCHANT_AUDIT=PASS'
if [[ "$MODE" == --plan ]];then
 echo 'RC814_PICKUP_BACKEND_PLAN=PASS_NO_WRITES'
 exit 0
fi
# Existing promotion takes private full pg_dump backup, validates LIVE money,
# and protects the two PM2 app identities and previous immutable source.
bash scripts/rc813-unified-live-cutover.sh "$SHA" I_APPROVE_RC813_EXISTING_LIVE_PM2_CUTOVER
bash scripts/rc814-pickup-live-go-live.sh --verify "$SHA"
echo 'RC814_PICKUP_LIVE_BACKEND_DEPLOYED=PASS'
echo 'RC814_SELLER_ONBOARDING_STILL_REQUIRED=YES'
