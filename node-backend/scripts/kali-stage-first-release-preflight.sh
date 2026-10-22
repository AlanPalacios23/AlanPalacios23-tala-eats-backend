#!/usr/bin/env bash
# Strict read-only preflight for native Kali PM2 staging. No service restarts.
set -Eeuo pipefail
[[ "$#" -eq 0 || ( "$#" -eq 1 && "$1" == "--plan" ) ]] || { echo "USAGE --plan"; exit 2; }
[[ "$(id -un)" == "tala-node-stage" && "$HOME" == "/home/tala-node-stage" ]] || {
  echo "ABORT_STAGE_USER_ONLY"; exit 1;
}
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
SCRIPT_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
[[ "$SCRIPT_ROOT" == /home/tala-node-stage/* && ! -L "$SCRIPT_ROOT" ]] || {
  echo "ABORT_STAGE_SOURCE_ONLY"; exit 1;
}
for t in node pm2 curl ss git; do
  command -v "$t" >/dev/null 2>&1 || { echo "ABORT_MISSING_$t"; exit 1; }
done
node -e 'let a=process.versions.node.split(".").map(Number);if(a[0]!==24||a[1]<11)process.exit(1)' || {
  echo "ABORT_NODE24_REQUIRED"; exit 1;
}
ENVFILE="$HOME/.config/talaeats-node-staging.env"
[[ -f "$ENVFILE" && ! -L "$ENVFILE" &&
   "$(stat -c '%a' "$ENVFILE")" == 600 &&
   "$(stat -c '%u' "$ENVFILE")" == "$(id -u)" ]] || {
  echo "ABORT_ENV_STAGING_PRIVATE"; exit 1;
}
node --env-file="$ENVFILE" --input-type=module - <<'JS'
const p=new URL(process.env.DATABASE_URL||'https://invalid');
const r=new URL(process.env.REDIS_URL||'https://invalid');
if(process.env.NODE_ENV!=='staging'||process.env.HOST!=='127.0.0.1'||
  process.env.PORT!=='18190'||process.env.STRIPE_FINANCIAL_WRITES_ENABLED!=='false'||
  !['postgres:','postgresql:'].includes(p.protocol)||
  p.hostname!=='127.0.0.1'||p.port!=='15435'||
  p.username!=='tala_node_stage'||p.pathname!=='/tala_node_stage'||!p.password||
  r.protocol!=='redis:'||r.hostname!=='127.0.0.1'||r.port!=='16379'||
  r.pathname!=='/0'||!r.password||
  String(process.env.STRIPE_SECRET_KEY||'').startsWith('sk_live_')||
  Object.keys(process.env).some(k=>/^(MERCADOPAGO_|MP_ACCESS_TOKEN$|MP_PUBLIC_KEY$|MP_WEBHOOK_SECRET$)/i.test(k)))process.exit(1);
JS
echo "ISOLATED_PG15_REDIS8_STAGE_ENV=PASS"
for port in 15435 16379 18190; do
  result="$(ss -lntH | awk -v port="$port" '$4 ~ ":"port"$" {print $4}')"
  [[ "$(printf '%s\n' "$result" | sed '/^$/d' | wc -l)" == 1 &&
    "$result" == "127.0.0.1:$port" ]] || {
    echo "ABORT_STAGE_PORT_NOT_EXCLUSIVELY_LOOPBACK=$port"; exit 1;
  }
done
echo "STAGE_PORTS_LOOPBACK_ONLY=PASS"
CURRENT_DIR="$(pm2 jlist | node -e '
let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{
try{const a=JSON.parse(s), names=a.map(x=>x.name).sort();
if(JSON.stringify(names)!==JSON.stringify(["tala-node-stage-api","tala-node-stage-worker"])||
a.some(x=>x.pm2_env?.status!=="online"))process.exit(1);
const p=a.map(x=>x.pm2_env.pm_cwd);
if(p.length!==2||p[0]!==p[1]||!p[0].startsWith("/home/tala-node-stage/")||
!p[0].endsWith("/node-backend"))process.exit(2);
process.stdout.write(p[0]);}catch{process.exit(3)}
})')" || { echo "ABORT_PM2_STAGE_ONLY"; exit 1; }
[[ -f "$CURRENT_DIR/ecosystem.config.cjs" ]] || { echo "ABORT_ACTIVE_PM2_BUILD_MISSING"; exit 1; }
CURRENT_SHA="$(git -C "$CURRENT_DIR" rev-parse --verify HEAD 2>/dev/null)" || {
  echo "ABORT_CURRENT_PM2_SHA_NOT_AVAILABLE"; exit 1;
}
echo "CURRENT_PM2_SHA=$CURRENT_SHA"
curl -fsS --max-time 5 http://127.0.0.1:18190/api/v1/ready |
node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{
try{const v=JSON.parse(s);
process.exit(v.ready===true&&v.database===true&&v.redis===true&&v.financialWrites===false?0:1)
}catch{process.exit(1)}
})' || { echo "ABORT_STAGE_NOT_READY"; exit 1; }
echo "STAGE_BASELINE_PG_REDIS_API_READY=PASS"
if command -v systemctl >/dev/null 2>&1; then
  for unit in tala-node-stage-pg15.service tala-node-stage-redis.service tala-node-stage-pm2.service; do
    if systemctl --user is-active --quiet "$unit" 2>/dev/null; then
      echo "USER_SYSTEMD_$unit=ACTIVE"
    else
      echo "USER_SYSTEMD_$unit=UNKNOWN_REVIEW_REQUIRED"
    fi
  done
fi
free_kib="$(df -Pk "$HOME" | awk 'END{print $4}')"
[[ "$free_kib" =~ ^[0-9]+$ && "$free_kib" -ge 1048576 ]] || {
  echo "ABORT_DISK_BELOW_1_GIB_FOR_RELEASE"; exit 1;
}
echo "DISK_FREE_AT_LEAST_1_GIB=PASS"
echo "FIRST_KALI_RELEASE_PREFLIGHT=PASS_READ_ONLY"
echo "BACKUP_RESTORE_MIGRATIONS_STILL_REQUIRE_SEPARATE_APPROVAL=YES"
