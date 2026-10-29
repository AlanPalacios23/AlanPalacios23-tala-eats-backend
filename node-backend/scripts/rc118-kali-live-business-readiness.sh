#!/usr/bin/env bash
# RC11.2–RC11.7 business readiness on a pinned LIVE release.
# Read-only Stripe GET/DB SELECT/Redis GET/PWA GET; never a commercial GO.
set -Eeuo pipefail
set +x
umask 077
if [[ $# -ne 1 ]];then echo RC118_READINESS=HOLD_SHA_REQUIRED;exit 2;fi
sha="$1"
if [[ ! "$sha" =~ ^[a-f0-9]{40}$ ||
      "$(id -un)" != tala-node-stage || "$HOME" != /home/tala-node-stage ||
      "$(id -u)" == 0 ]];then
 echo RC118_READINESS=HOLD_SERVICE_USER_OR_SHA;exit 2
fi
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
for cmd in node git timeout;do
 command -v "$cmd" >/dev/null || { echo RC118_READINESS=HOLD_DEPENDENCY;exit 2; }
done
root="$HOME/tala-node-releases/$sha"
[[ -d "$root/node-backend" ]] ||
 { echo RC118_READINESS=HOLD_RELEASE_MISSING;exit 2; }
[[ "$(git -C "$root" rev-parse HEAD)" == "$sha" ]] ||
 { echo RC118_READINESS=HOLD_RELEASE_MISMATCH;exit 2; }
envfile="$HOME/.config/talaeats-node-live.env"
[[ -f "$envfile" && ! -L "$envfile" &&
    "$(stat -c '%a' "$envfile")" == 600 &&
    "$(stat -c '%u' "$envfile")" == "$(id -u)" ]] ||
 { echo RC118_READINESS=HOLD_LIVE_ENV;exit 2; }
cd "$root/node-backend"
[[ -s dist/server.js && -s dist/live/production-worker.js ]] ||
 { echo RC118_READINESS=HOLD_UNBUILT_RELEASE;exit 2; }
node --env-file="$envfile" --input-type=module <<'JS'
import {config} from './dist/config.js';
const pg=new URL(config.DATABASE_URL);
if(config.NODE_ENV!=='production'||config.PORT!==18190||
 pg.hostname!=='127.0.0.1'||pg.port!=='15445'||pg.pathname!=='/tala_node_live')
 throw Error('RC118_READINESS=HOLD_NOT_LIVE_DATABASE');
console.log('RC118_LIVE_PRODUCTION_IDENTITY=PASS');
JS
failed=0
run_check(){
 local label="$1" script="$2"
 echo "RC118_CHECK=$label"
 if timeout 120s node --env-file="$envfile" "scripts/$script" "$sha";then
  echo "RC118_CHECK_RESULT=PASS_READONLY_$label"
 else
  echo "RC118_CHECK_RESULT=HOLD_$label"
  failed=$((failed+1))
 fi
}
run_check CASH_CAPACITY rc114-kali-live-cash-readiness.mjs
run_check RESTAURANT_DRIVER_CONNECT rc115-kali-live-connect-readiness.mjs
run_check OWNER_DRIVER_AND_OUTBOX_DIAGNOSTIC rc119-kali-live-blockers-diagnostic.mjs
run_check FINANCIAL_RECOVERY rc116-kali-live-financial-recovery-audit.mjs
run_check API_AND_THREE_PWAS rc117-kali-live-public-preflight.mjs
echo RC118_FINANCIAL_WRITES=NONE
echo RC118_AUTO_RELEASE=NO
echo RC118_REAL_COMMERCE_E2E=NOT_VERIFIED
if [[ "$failed" -ne 0 ]];then
 echo "RC118_READINESS=HOLD_FAILED_CHECK_COUNT_$failed";exit 2
fi
echo RC118_READINESS=PASS_READONLY_NOT_COMMERCIAL_GO
