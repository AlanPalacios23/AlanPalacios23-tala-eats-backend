#!/usr/bin/env bash
# Stop the extra RC8.13 staging-only PM2 daemon AFTER unified LIVE is verified.
# No database deletion, no Redis flush, no filesystem/env deletion, no LIVE PM2.
set -Eeuo pipefail
set +x
MODE="${1:-}"; SHA="${2:-}"; APPROVAL="${3:-}"
if [[ "$#" -lt 2 || "$#" -gt 3 || ! "$MODE" =~ ^--(plan|apply)$ ||
      ! "$SHA" =~ ^[a-f0-9]{40}$ ]];then
 echo 'USAGE: bash scripts/rc813-retire-parallel-stage.sh --plan|--apply EXACT_SHA [I_APPROVE_STOP_RC813_STAGING_PM2_ONLY]';exit 2
fi
[[ "$(id -un)" == tala-node-stage && "$HOME" == /home/tala-node-stage ]] || exit 1
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
cd "$HOME/tala-node-releases/$SHA/node-backend"
bash scripts/rc813-unified-live-preflight.sh --verify "$SHA"
# LIVE production must really be the requested SHA, not merely healthy.
node --input-type=module - "$SHA" <<'JS'
import {execFileSync} from 'node:child_process';
const sha=process.argv[2];
const p=JSON.parse(execFileSync('pm2',['jlist'],{encoding:'utf8',timeout:10000,
 env:{...process.env,PM2_HOME:'/home/tala-node-stage/.pm2'}}));
if(p.length!==2||p.some(x=>x.pm2_env?.pm_cwd!==
 '/home/tala-node-stage/tala-node-releases/'+sha+'/node-backend'||
 x.pm2_env?.status!=='online'))throw Error('RC813_LIVE_NOT_UNIFIED_AT_EXACT_SHA');
console.log('RC813_UNIFIED_LIVE_SHA_AND_TWO_PM2=PASS');
JS
STAGE_HOME="$HOME/.pm2-tala-rc813-parallel"
[[ -d "$STAGE_HOME" && ! -L "$STAGE_HOME" &&
  "$(stat -c '%u' "$STAGE_HOME")" == "$(id -u)" ]] || {
 echo 'RC813_PARALLEL_STAGE_PM2_MISSING_OR_UNTRUSTED';exit 1;
}
stage_pm2(){
 env -i HOME="$HOME" USER=tala-node-stage LOGNAME=tala-node-stage \
  PATH="$PATH" PM2_HOME="$STAGE_HOME" pm2 "$@"
}
# Existing stage daemon must have only the expected two stage-only names.
stage_pm2 jlist | node -e '
let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{
 try{const p=JSON.parse(s),names=p.map(x=>x.name).sort();
 if(JSON.stringify(names)!==JSON.stringify(["tala-rc813-parallel-api","tala-rc813-parallel-worker"]))
 process.exit(1);
 console.log("RC813_STAGE_ONLY_PROCESS_IDENTITIES=PASS")
 }catch{process.exit(1)}
})'
if [[ "$MODE" == --plan ]];then
 echo 'RC813_PARALLEL_STAGE_RETIRE_PLAN=PASS_READ_ONLY';exit 0
fi
[[ "$APPROVAL" == I_APPROVE_STOP_RC813_STAGING_PM2_ONLY ]] || {
 echo 'RC813_STAGE_RETIRE_EXPLICIT_APPROVAL_REQUIRED';exit 2;
}
stage_pm2 delete tala-rc813-parallel-api
stage_pm2 delete tala-rc813-parallel-worker
stage_pm2 kill
if ss -lntH | awk '{print $4}' | grep -Eq '(^|:)18192$';then
 echo 'RC813_PARALLEL_STAGE_PORT_STILL_LISTENING=REVIEW';exit 1
fi
bash scripts/rc813-unified-live-preflight.sh --verify "$SHA"
echo 'RC813_ONLY_LIVE_PM2_RUNTIME=PASS'
echo 'RC813_STAGE_DATABASE_REDIS_BACKUPS_UNMODIFIED=YES'
echo 'RC813_CLOUDFLARED_AND_LEGAL_ROUTES_UNMODIFIED=YES'
