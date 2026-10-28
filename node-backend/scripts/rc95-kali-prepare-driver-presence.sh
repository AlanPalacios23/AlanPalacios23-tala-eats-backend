#!/usr/bin/env bash
# RC9.5 — prepare only. Does not change LIVE services, env, database or Stripe.
set -Eeuo pipefail
set +x
umask 077
MODE="${1:-}"; SHA="${2:-}"
if [[ $# != 2 || ! "$MODE" =~ ^--(plan|prepare|verify)$ ||
      ! "$SHA" =~ ^[a-f0-9]{40}$ ]];then
 echo 'RC95_PREPARE_ABORT=USAGE';exit 2
fi
if [[ "$(id -un)" != tala-node-stage || "$(id -u)" == 0 ||
      "$HOME" != /home/tala-node-stage ]];then
 echo 'RC95_PREPARE_ABORT=SERVICE_ACCOUNT_ONLY';exit 1
fi
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
for cmd in git npm node pm2 curl;do
 command -v "$cmd" >/dev/null || { echo "RC95_PREPARE_ABORT=MISSING_TOOL_$cmd";exit 1; }
done
node -e 'let [major,minor]=process.versions.node.split(".").map(Number);process.exit(major===24&&minor>=11?0:1)' ||
 { echo 'RC95_PREPARE_ABORT=NODE24_11_REQUIRED';exit 1; }
OLD_SHA=0c8d92fa62ae910843b3d4c764da85a852b17085
PARENT="$HOME/tala-node-releases"
ROOT="$PARENT/$SHA"
WORK="$ROOT/node-backend"
OLD="$PARENT/$OLD_SHA/node-backend"
ENV="$HOME/.config/talaeats-node-live.env"
REMOTE=https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend.git
[[ "$SHA" != "$OLD_SHA" && -d "$OLD" && ! -L "$OLD" &&
   -d "$PARENT" && ! -L "$PARENT" &&
   -f "$ENV" && ! -L "$ENV" &&
   "$(stat -c %a "$ENV")" == 600 &&
   "$(stat -c %u "$ENV")" == "$(id -u)" ]] ||
  { echo 'RC95_PREPARE_ABORT=LIVE_BASE_OR_ENV_INVARIANTS';exit 1; }
# Check current two PM2 processes in production before even fetching source.
export RC95_OLD_DIR="$OLD"
pm2 jlist | node --input-type=commonjs -e '
let v="";process.stdin.on("data",x=>v+=x);process.stdin.on("end",()=>{
 try{
 const all=JSON.parse(v),want={
 "tala-node-stage-api":"dist/server.js",
 "tala-node-stage-worker":"dist/live/production-worker.js"};
 if(all.length!==2)throw Error("COUNT");
 for(const [name,path] of Object.entries(want)){
  const r=all.filter(x=>x.name===name);
  if(r.length!==1||r[0].pm2_env?.status!=="online"||
     r[0].pm2_env?.pm_cwd!==process.env.RC95_OLD_DIR||
     r[0].pm2_env?.pm_exec_path!==process.env.RC95_OLD_DIR+"/"+path)
     throw Error("PM2_MISMATCH");
 }
 console.log("RC95_EXISTING_PM2_RC94=PASS");
 }catch{console.log("RC95_PREPARE_ABORT=PM2_LIVE_CHANGED");process.exitCode=1;}
});'
curl -fSs --max-time 10 http://127.0.0.1:18190/api/v1/ready |
node -e '
let t="";process.stdin.on("data",x=>t+=x);process.stdin.on("end",()=>{
 try{const r=JSON.parse(t);
 if(r.ready!==true||r.workerOnline!==true||r.environment!=="production"||
    r.onlinePaymentsEnabled!==true)throw Error("NOT_READY");
 console.log("RC95_EXISTING_LIVE_STRIPE_READY=PASS");
 }catch{console.log("RC95_PREPARE_ABORT=LIVE_NOT_READY");process.exitCode=1;}
});'
if [[ "$MODE" == --plan ]];then
 echo "RC95_TARGET_SHA=$SHA"
 echo 'RC95_PREPARE_PLAN=PASS_READ_ONLY'
 echo 'RC95_PM2=UNCHANGED'
 echo 'RC95_DATABASE=UNCHANGED'
 echo 'RC95_EMAIL_AND_STRIPE=UNCHANGED'
 exit 0
fi
if [[ "$MODE" == --prepare ]];then
 [[ ! -e "$ROOT" ]] ||
  { echo 'RC95_PREPARE_ABORT=TARGET_DIR_EXISTS_USE_VERIFY';exit 1; }
 # Only clone immutable SHA, no reference to LIVE .env.
 git init -q "$ROOT"
 git -C "$ROOT" remote add origin "$REMOTE"
 git -C "$ROOT" fetch -q --depth 1 origin "$SHA"
 git -C "$ROOT" checkout -q --detach "$SHA"
fi
[[ -d "$WORK" && ! -L "$WORK" &&
  "$(git -C "$ROOT" rev-parse HEAD)" == "$SHA" &&
  -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" &&
  "$(git -C "$ROOT" remote get-url origin)" == "$REMOTE" ]] ||
  { echo 'RC95_PREPARE_ABORT=RELEASE_SHA_OR_GIT_STATE';exit 1; }
# Refuse a deployment candidate containing changed DB migrations or PM2 topology.
cmp -s "$OLD/rc813-live/ecosystem.config.cjs" "$WORK/rc813-live/ecosystem.config.cjs" ||
  { echo 'RC95_PREPARE_ABORT=PM2_TOPOLOGY_CHANGED';exit 1; }
diff -qr "$OLD/prisma/migrations" "$WORK/prisma/migrations" >/dev/null ||
  { echo 'RC95_PREPARE_ABORT=DATABASE_MIGRATIONS_CHANGED';exit 1; }
if [[ "$MODE" == --prepare ]];then
 cd "$WORK"
 # Build environment cannot use production secrets or talk to production DB.
 env -i HOME="$HOME" PATH="$PATH" USER=tala-node-stage LOGNAME=tala-node-stage \
  NODE_ENV=staging HOST=127.0.0.1 PORT=18190 \
  DATABASE_URL='postgresql://invalid:invalid@127.0.0.1:15435/invalid' \
  REDIS_URL='redis://:invalid@127.0.0.1:16379/0' \
  STRIPE_LIVE_ENABLED=false STRIPE_FINANCIAL_WRITES_ENABLED=false \
  STRIPE_CONNECT_TRANSFERS_ENABLED=false \
  npm ci --no-audit --no-fund
 env -i HOME="$HOME" PATH="$PATH" USER=tala-node-stage LOGNAME=tala-node-stage \
  NODE_ENV=staging HOST=127.0.0.1 PORT=18190 \
  DATABASE_URL='postgresql://invalid:invalid@127.0.0.1:15435/invalid' \
  REDIS_URL='redis://:invalid@127.0.0.1:16379/0' \
  STRIPE_LIVE_ENABLED=false STRIPE_FINANCIAL_WRITES_ENABLED=false \
  STRIPE_CONNECT_TRANSFERS_ENABLED=false \
  npm run generate
 npm run build
 node --test tests/rc95-driver-presence.test.mjs tests/rc95-live-delivery-audit.test.mjs
 python3 scripts/node_route_coverage.py --check
fi
[[ -f "$WORK/dist/server.js" && -f "$WORK/dist/live/production-worker.js" &&
   -f "$WORK/dist/marketplace/delivery-runtime.js" ]] ||
 { echo 'RC95_PREPARE_ABORT=COMPILED_ARTIFACT_MISSING';exit 1; }
echo 'RC95_DRIVER_PRESENCE_CANDIDATE=PASS'
echo 'RC95_LIVE_CUTOVER=NOT_PERFORMED'
echo 'RC95_LIVE_DELIVERY_CHECKOUT=LOCKED'
echo 'RC95_LIVE_STRIPE_DELIVERY=LOCKED'
echo 'RC95_CONNECT_PAYOUTS=LOCKED'
