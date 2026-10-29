#!/usr/bin/env bash
# RC11.7 guarded LIVE code release. NO test payments or LIVE money changes.
# Run from exact SHA release: --plan SHA, --apply SHA OLD_SHA I_APPROVE_RC117_LIVE_CODE_ONLY, --verify SHA.
set -Eeuo pipefail
set +x
umask 077
if [[ $# -lt 2 ]];then echo RC117_CODE_RELEASE=HOLD_INVALID_ARGUMENTS;exit 2;fi
mode="$1";sha="$2"
if [[ ! "$mode" =~ ^--(plan|apply|verify)$ || ! "$sha" =~ ^[a-f0-9]{40}$ ]];then
 echo RC117_CODE_RELEASE=HOLD_INVALID_ARGUMENTS;exit 2
fi
case "$mode" in
 --plan|--verify)
  [[ $# -eq 2 ]] || { echo RC117_CODE_RELEASE=HOLD_ARGUMENTS;exit 2; };;
 --apply)
  [[ $# -eq 4 && "$3" =~ ^[a-f0-9]{40}$ &&
     "$4" == I_APPROVE_RC117_LIVE_CODE_ONLY ]] ||
    { echo RC117_CODE_RELEASE=HOLD_EXPLICIT_APPROVAL_REQUIRED;exit 2; };;
esac
[[ "$(id -un)" == tala-node-stage && "$(id -u)" != 0 &&
    "$HOME" == /home/tala-node-stage ]] ||
 { echo RC117_CODE_RELEASE=HOLD_SERVICE_USER;exit 2; }
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
for cmd in node npm git pm2 curl python3; do
 command -v "$cmd" >/dev/null ||
  { echo "RC117_CODE_RELEASE=HOLD_DEPENDENCY_$cmd";exit 2; }
done
[[ "$(node --version)" =~ ^v24\. ]] ||
 { echo RC117_CODE_RELEASE=HOLD_NODE_24_REQUIRED;exit 2; }
root="$HOME/tala-node-releases/$sha"
work="$root/node-backend"
[[ -d "$root" && ! -L "$root" && -d "$work" && ! -L "$work" &&
   "$(git -C "$root" rev-parse HEAD)" == "$sha" &&
   -z "$(git -C "$root" status --porcelain --untracked-files=no)" ]] ||
 { echo RC117_CODE_RELEASE=HOLD_PINNED_RELEASE_MISSING;exit 2; }
cd "$work"
[[ -s package-lock.json &&
   -s scripts/rc114-kali-live-code-cutover.sh &&
   -s scripts/rc117-kali-live-public-preflight.mjs ]] ||
 { echo RC117_CODE_RELEASE=HOLD_RELEASE_FILES;exit 2; }
if [[ "$mode" != --verify ]];then
 echo RC117_CODE_PREPARE=START
 npm ci --no-audit --no-fund
 npm run verify
 test -s dist/server.js
 test -s dist/live/production-worker.js
 bash scripts/rc114-kali-live-code-cutover.sh --plan "$sha"
 echo RC117_CODE_PREPARE=PASS
fi
if [[ "$mode" == --plan ]];then
 echo RC117_DEPLOYMENT=READY_FOR_EXPLICIT_CODE_ONLY_APPROVAL
 echo RC117_MONEY_FLAGS=UNCHANGED
 exit 0
fi
if [[ "$mode" == --apply ]];then
 bash scripts/rc114-kali-live-code-cutover.sh --apply "$sha" "$3" \
  I_APPROVE_RC114_LIVE_TWO_PM2_CASH_DELIVERY_CODE_ONLY
fi
bash scripts/rc114-kali-live-code-cutover.sh --verify "$sha"
node --env-file="$HOME/.config/talaeats-node-live.env" \
 scripts/rc117-kali-live-public-preflight.mjs "$sha"
echo RC117_BACKEND_AND_PUBLIC_PWA_HTTP=PASS
echo RC117_LIVE_CODE_RELEASE=PASS
echo RC117_PRODUCTION_PAYMENTS_OR_WITHDRAWALS_NEWLY_ACTIVATED=NO
echo RC117_REAL_COMMERCIAL_E2E=NOT_YET_VERIFIED
