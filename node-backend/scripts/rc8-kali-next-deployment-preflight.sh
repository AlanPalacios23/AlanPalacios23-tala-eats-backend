#!/usr/bin/env bash
# RC8 KALI NEXT DEPLOYMENT: code-only safety gate. No LIVE runtime rollout.
# MUST NOT edit stage PM2, Cloudflared, PG/Redis, or Stripe keys.
set -Eeuo pipefail
set +x
umask 077

if [[ $# -ne 2 || "$1" != "--plan" || ! "$2" =~ ^[a-f0-9]{40}$ ]]; then
  echo "USAGE: bash scripts/rc8-kali-next-deployment-preflight.sh --plan <RC8_FULL_SHA>"
  exit 2
fi
if [[ "$(id -un)" != "tala-node-stage" ||
      "$HOME" != "/home/tala-node-stage" ]]; then
  echo "RC8_PREFLIGHT_ABORT=STAGE_OPERATOR_ONLY"
  exit 1
fi

export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
for exe in git node npm pm2 curl python3; do
  command -v "$exe" >/dev/null || { echo "RC8_PREFLIGHT_ABORT=TOOL_$exe"; exit 1; }
done

SHA="$2"
EXPECTED_STAGE="343579328c51eb0e4de8751fa8bab6c23c523662"
ROOT="$HOME/tala-node-releases/$SHA"
[[ -d "$ROOT/node-backend" && ! -L "$ROOT" && ! -L "$ROOT/node-backend" ]] ||
  { echo "RC8_PREFLIGHT_ABORT=SOURCE_DIRECTORY"; exit 1; }
[[ "$(git -C "$ROOT" rev-parse --verify HEAD)" == "$SHA" ]] ||
  { echo "RC8_PREFLIGHT_ABORT=SOURCE_SHA"; exit 1; }
[[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]] ||
  { echo "RC8_PREFLIGHT_ABORT=DIRTY_REVIEWED_RELEASE"; exit 1; }
cd "$ROOT/node-backend"
for path in src/live/guard.ts src/live/postgres-store.ts             src/live/stripe-payments.ts src/live/webhook-inbox.ts             src/live/reconcile.ts src/live/financial-readiness.ts; do
  [[ -f "$path" ]] || { echo "RC8_PREFLIGHT_ABORT=MISSING_LIVE_MODULE"; exit 1; }
done
node scripts/release-readiness.mjs --stage >/dev/null ||
  { echo "RC8_PREFLIGHT_ABORT=STAGE_CODE_SAFETY"; exit 1; }

# Never claim RC8 has been deployed just because the source is built.
CURRENT="$(pm2 jlist | node -e '
let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{
try{
 const a=JSON.parse(s), names=a.map(x=>x.name).sort();
 if(JSON.stringify(names)!==JSON.stringify(["tala-node-stage-api","tala-node-stage-worker"])||
    a.some(x=>x.pm2_env?.status!=="online"))process.exit(1);
 const x=a.find(x=>x.name==="tala-node-stage-api")?.pm2_env?.pm_cwd;
 const y=a.find(x=>x.name==="tala-node-stage-worker")?.pm2_env?.pm_cwd;
 if(typeof x!=="string"||x!==y||!x.endsWith("/node-backend"))process.exit(1);
 process.stdout.write(x)
}catch{process.exit(1)}
})')" || { echo "RC8_PREFLIGHT_ABORT=STAGE_PM2_IDENTITY"; exit 1; }
[[ "$(git -C "$CURRENT" rev-parse --verify HEAD)" == "$EXPECTED_STAGE" ]] ||
  { echo "RC8_PREFLIGHT_ABORT=RC7_ACTIVE_BASE_CHANGED"; exit 1; }

bash scripts/rc7-kali-finance-preflight.sh >/dev/null ||
  { echo "RC8_PREFLIGHT_ABORT=RC7_READINESS"; exit 1; }
echo "RC7_ACTIVE_STAGE_PRESERVED=PASS"
echo "RC8_CANDIDATE_SOURCE_SHA=$SHA"
echo "RC8_CODE_ONLY_PREFLIGHT=PASS"
echo "LIVE_PAYMENT_CUTOVER=NOT_AUTHORIZED"
echo "RC8_PM2_CLOUDFLARE_POSTGRES_REDIS=NOT_MODIFIED"
echo "NEXT=Review isolated production auth, refunds/disputes, Connect, Android PaymentSheet and real TEST E2E before LIVE"
