#!/usr/bin/env bash
# Read-only Kali stage post-deployment smoke. Never starts/stops PM2 or writes DB.
set -Eeuo pipefail
if [[ "$#" != 1 || ! "$1" =~ ^[a-f0-9]{40}$ ]]; then
  echo "USAGE: bash node-backend/scripts/kali-stage-postdeploy-smoke.sh <FULL_DEPLOYED_SHA>"
  exit 2
fi
EXPECTED="$1"
[[ "$(id -un)" == "tala-node-stage" && "$(id -u)" != 0 &&
   "$HOME" == "/home/tala-node-stage" ]] || {
  echo "ABORT_STAGE_USER_ONLY"; exit 1;
}
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
for name in pm2 node curl git; do
  command -v "$name" >/dev/null 2>&1 || { echo "ABORT_MISSING_$name"; exit 1; }
done
node -e 'const v=process.versions.node.split(".").map(Number);if(v[0]!==24||v[1]<11)process.exit(1)'
ENVFILE="$HOME/.config/talaeats-node-staging.env"
[[ -f "$ENVFILE" && ! -L "$ENVFILE" &&
   "$(stat -c '%a' "$ENVFILE")" == 600 &&
   "$(stat -c '%u' "$ENVFILE")" == "$(id -u)" ]] || {
   echo "ABORT_PRIVATE_ENV"; exit 1;
}
# Confirm processes are only the two named stage apps, online and same cwd.
ACTIVE_DIR="$(pm2 jlist | node -e '
let str="";process.stdin.on("data",x=>str+=x);process.stdin.on("end",()=>{
  try {
    const x=JSON.parse(str);
    const names=x.map(y=>y.name).sort();
    if(JSON.stringify(names)!==JSON.stringify(["tala-node-stage-api","tala-node-stage-worker"]))process.exit(1);
    if(x.some(y=>y.pm2_env?.status!=="online"))process.exit(2);
    const a=x.find(y=>y.name==="tala-node-stage-api")?.pm2_env?.pm_cwd;
    const b=x.find(y=>y.name==="tala-node-stage-worker")?.pm2_env?.pm_cwd;
    if(!a||!a.startsWith("/home/tala-node-stage/")||!a.endsWith("/node-backend")||a!==b)process.exit(3);
    process.stdout.write(a);
  }catch{process.exit(4)}
})')" || { echo "ABORT_STAGE_PM2_IDENTITIES"; exit 1; }
ACTUAL="$(git -C "$ACTIVE_DIR" rev-parse --verify HEAD 2>/dev/null)" || {
  echo "ABORT_ACTIVE_RELEASE_GIT_SHA_UNAVAILABLE"; exit 1;
}
[[ "$ACTUAL" == "$EXPECTED" ]] || {
  echo "ABORT_ACTIVE_RELEASE_SHA_MISMATCH"
  echo "STAGE_ACTUAL_SHA=$ACTUAL"
  exit 1
}
echo "PM2_API_WORKER_SHA=PASS"
# Health checks require the NEW candidate version and Stripe-only markers.
curl --silent --show-error --fail --max-time 5 http://127.0.0.1:18190/api/v1/health |
  node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{
    try{const j=JSON.parse(s);process.exit(j.status==="ok" &&
      j.production===false && j.digital_payment_provider==="stripe" &&
      j.online_payment_writes===false?0:1)}catch{process.exit(1)}
  })' || { echo "ABORT_STAGE_HEALTH_CONTRACT"; exit 1; }
echo "NODE_STRIPE_ONLY_HEALTH=PASS"
curl --silent --show-error --fail --max-time 5 http://127.0.0.1:18190/api/v1/ready |
  node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{
    try{const j=JSON.parse(s);process.exit(j.ready===true &&
      j.database===true && j.redis===true && j.financialWrites===false &&
      j.digitalPaymentProvider==="stripe" && j.onlinePaymentsEnabled===false
      ?0:1)}catch{process.exit(1)}
  })' || { echo "ABORT_STAGE_READINESS_CONTRACT"; exit 1; }
echo "PG15_REDIS8_READINESS_STRIPE_TEST_NO_FINANCIAL_WRITES=PASS"
# No logs, tokens, environment secrets or production data printed.
echo "KALI_NODE_PM2_STAGE_POSTDEPLOY_SMOKE=PASS"
echo "LIVE_PRODUCTION_TOUCHED=NO"
