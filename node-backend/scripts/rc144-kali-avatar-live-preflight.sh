#!/usr/bin/env bash
# RC144 avatar-only LIVE preflight. --plan and --post are STRICTLY READ-ONLY.
# No PM2, nginx, DB, Redis, Stripe, flags, uploads or file changes.
set -Eeuo pipefail
set +x
export GIT_OPTIONAL_LOCKS=0
umask 077
MODE="${1:-}" NEW_SHA="${2:-}"
OLD_SHA='f92f5d9a52856f24e155dcbc140dcff0e266056a'
ROOT="/home/tala-node-stage/tala-node-releases/$NEW_SHA"
WORK="$ROOT/node-backend"
ENV='/home/tala-node-stage/.config/talaeats-node-live.env'
STORAGE='/srv/talaeats-media/driver-avatars'
[[ "$#" -eq 2 && "$MODE" =~ ^--(plan|post)$ &&
   "$NEW_SHA" =~ ^[0-9a-f]{40}$ ]] || {
 echo 'RC144_AVATAR_GATE=HOLD_USAGE';exit 2;
}
[[ "$(id -un)" == tala-node-stage && "$HOME" == /home/tala-node-stage ]] || {
 echo 'RC144_AVATAR_GATE=HOLD_SERVICE_USER';exit 2;
}
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
for cmd in git node npm pm2 stat curl grep;do command -v "$cmd" >/dev/null || {
 echo "RC144_AVATAR_GATE=HOLD_MISSING_$cmd";exit 2;};done
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 24 ]] || {
 echo 'RC144_AVATAR_GATE=HOLD_NODE24';exit 2;
}
[[ -d "$ROOT" && ! -L "$ROOT" && -d "$WORK" && ! -L "$WORK" ]] || {
 echo 'RC144_AVATAR_GATE=HOLD_CANDIDATE_RELEASE_MISSING';exit 2;
}
actual="$(git -C "$ROOT" rev-parse HEAD)" || {
 echo 'RC144_AVATAR_GATE=HOLD_GIT_HEAD';exit 2;
}
tracked="$(git -C "$ROOT" status --porcelain --untracked-files=no)" || {
 echo 'RC144_AVATAR_GATE=HOLD_GIT_INDEX';exit 2;
}
[[ "$actual" == "$NEW_SHA" && -z "$tracked" ]] || {
 echo 'RC144_AVATAR_GATE=HOLD_SHA_OR_DIRTY_TREE';exit 2;
}
git -C "$ROOT" cat-file -e "$OLD_SHA^{commit}" || {
 echo 'RC144_AVATAR_GATE=HOLD_OLD_COMMIT_NOT_IN_HISTORY';exit 2;
}
git -C "$ROOT" merge-base --is-ancestor "$OLD_SHA" "$NEW_SHA" || {
 echo 'RC144_AVATAR_GATE=HOLD_NOT_DESCENDANT_OF_APPROVED_LIVE';exit 2;
}
DIFF="$(git -C "$ROOT" diff --name-only "$OLD_SHA" "$NEW_SHA")" || {
 echo 'RC144_AVATAR_GATE=HOLD_DIFF_READ';exit 2;
}
[[ -n "$DIFF" ]] || { echo 'RC144_AVATAR_GATE=HOLD_EMPTY_DIFF';exit 2; }
while IFS= read -r item;do
 case "$item" in
  node-backend/package.json|node-backend/package-lock.json|  node-backend/src/app.ts|node-backend/src/auth/routes.ts|  node-backend/src/config.ts|node-backend/src/driver-avatar.ts|  node-backend/src/marketplace/routes.ts|  node-backend/tests/rc144-driver-avatar-storage.test.mjs|  node-backend/docs/RC144-DRIVER-AVATAR-ROLLOUT.md|  node-backend/scripts/rc144-kali-avatar-live-preflight.sh|  node-backend/scripts/rc144-kali-avatar-storage.sh|\
  node-backend/scripts/rc144-kali-avatar-candidate-build.sh|\
  node-backend/tests/rc144-avatar-deploy.test.mjs)
   :;;
  *) echo "RC144_AVATAR_GATE=HOLD_UNRELATED_FILE:$item";exit 2;;
 esac
done <<< "$DIFF"
echo 'RC144_AVATAR_SCOPE=PASS_AVATAR_FILES_ONLY'
[[ -s "$WORK/package-lock.json" && -s "$WORK/dist/server.js" &&
   -s "$WORK/dist/live/production-worker.js" &&
   -s "$WORK/dist/driver-avatar.js" ]] || {
 echo 'RC144_AVATAR_GATE=HOLD_COMPILED_CANDIDATE';exit 2;
}
node -e '
const p=require(process.argv[1]),l=require(process.argv[2]);
if(p.dependencies.sharp!=="0.35.5"||
   l.packages?.["node_modules/sharp"]?.version!=="0.35.5")process.exit(1);
' "$WORK/package.json" "$WORK/package-lock.json" || {
 echo 'RC144_AVATAR_GATE=HOLD_SHARP_LOCK_NOT_PATCHED';exit 2;
}
[[ -f "$ENV" && ! -L "$ENV" && "$(stat -c '%a %U' "$ENV")" == "600 tala-node-stage" ]] || {
 echo 'RC144_AVATAR_GATE=HOLD_LIVE_ENV';exit 2;
}
# No pm2 env dumped or logged; only exact cwd, path and online status are read.
export RC144_EXPECTED_DIR="/home/tala-node-stage/tala-node-releases/$(
 [[ "$MODE" == --plan ]] && echo "$OLD_SHA" || echo "$NEW_SHA"
)/node-backend"
pm2 jlist | node -e '
let s="";process.stdin.on("data",v=>s+=v);process.stdin.on("end",()=>{
 try{
  const p=JSON.parse(s),want={
   "tala-node-stage-api":"dist/server.js",
   "tala-node-stage-worker":"dist/live/production-worker.js"};
  if(p.length!==2)throw Error("COUNT");
  for(const [name,relative] of Object.entries(want)){
   const found=p.filter(x=>x.name===name);
   if(found.length!==1)throw Error("MISSING");
   const e=found[0].pm2_env;
   if(e?.status!=="online"||e?.pm_cwd!==process.env.RC144_EXPECTED_DIR||
      e?.pm_exec_path!==process.env.RC144_EXPECTED_DIR+"/"+relative)
    throw Error("DIFFERENT_LIVE_CODE");
  }
  console.log("RC144_LIVE_PM2_IDENTITIES=PASS");
 }catch{console.log("RC144_AVATAR_GATE=HOLD_PM2_CHANGED");process.exitCode=2;}
});' || exit 2
curl -fsS --connect-timeout 4 --max-time 10  http://127.0.0.1:18190/api/v1/ready | node -e '
let s="";process.stdin.on("data",v=>s+=v);process.stdin.on("end",()=>{
 try{
  const x=JSON.parse(s);
  if(x.ready!==true||x.workerOnline!==true||
     x.environment!=="production")throw Error("UNREADY");
  console.log("RC144_LIVE_READY=PASS");
 }catch{console.log("RC144_AVATAR_GATE=HOLD_LIVE_READY");process.exitCode=2;}
});' || exit 2
[[ -d "$STORAGE" && ! -L "$STORAGE" &&
   "$(stat -c '%a %U:%G' "$STORAGE")" == '700 tala-node-stage:tala-node-stage' ]] || {
 echo 'RC144_AVATAR_GATE=HOLD_PERSISTENT_MEDIA_NOT_PROVISIONED';exit 2;
}
[[ -w "$STORAGE" && -x "$STORAGE" ]] || {
 echo 'RC144_AVATAR_GATE=HOLD_STORAGE_NOT_WRITABLE';exit 2;
}
# Three HTTPS origins must each proxy existing API, not accidentally serve HTML.
for entry in  '18195|web-talaeats.alan-palacios-dev.com'  '18197|restaurantes-talaeats.alan-palacios-dev.com'  '18199|repartidores-talaeats.alan-palacios-dev.com';do
 IFS='|' read -r port host <<< "$entry"
 curl -fsS --connect-timeout 3 --max-time 9 -H "Host: $host"  "http://127.0.0.1:$port/api/v1/health" | node -e '
let s="";process.stdin.on("data",v=>s+=v);process.stdin.on("end",()=>{
 try{
  const v=JSON.parse(s);
  if(v.status!=="ok"||v.production!==true)throw Error("NOT_PROD_API");
 }catch{process.exitCode=2;}
});' || { echo "RC144_AVATAR_GATE=HOLD_API_PROXY:$port";exit 2; }
done
echo 'RC144_THREE_API_PROXIES=PASS'
if [[ "$MODE" == --post ]];then
 # Feature starts OFF: GET returns 503; after activation an unknown opaque
 # 40-hex image URL must return 404. Never send real image bytes or tokens.
 code="$(curl -sS --connect-timeout 3 --max-time 8 -o /dev/null -w '%{http_code}'    http://127.0.0.1:18190/api/v1/driver/avatar/0000000000000000000000000000000000000000.webp)" || {
 echo 'RC144_AVATAR_GATE=HOLD_AVATAR_READ_ROUTE';exit 2;
 }
 [[ "$code" == 503 || "$code" == 404 ]] || {
 echo "RC144_AVATAR_GATE=HOLD_AVATAR_READ_HTTP_$code";exit 2;
 }
fi
echo "RC144_AVATAR_PREFLIGHT=PASS_${MODE#--}_NO_MUTATIONS"
echo 'RC144_POSTGRESQL_STRIPE_FINANCE_ROUTES=UNMODIFIED'
echo 'RC144_REAL_AUTHENTICATED_UPLOAD=NOT_TESTED'
