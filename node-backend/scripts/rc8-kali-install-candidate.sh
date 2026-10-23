#!/usr/bin/env bash
# Fetch/build/test a pinned RC8 SHA as a separate Kali release directory.
# This is a CODE-ONLY candidate; never activates Stripe LIVE or PM2.
set -Eeuo pipefail
set +x
umask 077

if [[ $# != 2 || "$1" != "--prepare" || ! "$2" =~ ^[a-f0-9]{40}$ ]]; then
  echo "USAGE: bash scripts/rc8-kali-install-candidate.sh --prepare <RC8_FULL_SHA>"
  exit 2
fi
if [[ "$(id -un)" != "tala-node-stage" ||
      "$HOME" != "/home/tala-node-stage" ]]; then
  echo "ABORT_RC8_STAGE_USER_REQUIRED"
  exit 1
fi
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
for exe in git node npm pm2 curl; do
  command -v "$exe" >/dev/null || { echo "ABORT_RC8_MISSING_TOOL_$exe"; exit 1; }
done
FULL_SHA="$2"
RELEASE="$HOME/tala-node-releases/$FULL_SHA"
REPO_URL="https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend.git"
BRANCH="feat/rc8-stripe-live-isolated-20261023"

[[ -d "$HOME/tala-node-releases" && ! -L "$HOME/tala-node-releases" ]] ||
  { echo "ABORT_RC8_RELEASE_PARENT_UNSAFE"; exit 1; }
[[ ! -e "$RELEASE" && ! -L "$RELEASE" ]] ||
  { echo "ABORT_RC8_RELEASE_ALREADY_EXISTS"; exit 1; }

# Branch may advance between review and download. Abort unless it matches
# the exact reviewed immutable SHA. Never fetch or execute from main.
git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$RELEASE"
[[ "$(git -C "$RELEASE" rev-parse --verify HEAD)" == "$FULL_SHA" ]] ||
  { echo "ABORT_RC8_UNREVIEWED_REMOTE_SHA"; exit 1; }
[[ "$(git -C "$RELEASE" remote get-url origin)" == "$REPO_URL" ]] ||
  { echo "ABORT_RC8_UNEXPECTED_REMOTE"; exit 1; }

cd "$RELEASE/node-backend"
npm ci --no-audit --no-fund
npm run generate
npm run db:validate
npm run build
npm test

# Must observe existing RC7 untouched; intentionally no PM2 operations.
bash scripts/rc8-kali-next-deployment-preflight.sh --plan "$FULL_SHA"

echo "RC8_CODE_ONLY_INSTALL=PASS"
echo "RC8_PREPARED_SHA=$FULL_SHA"
echo "PUBLIC_RC7_STILL_ACTIVE=YES"
echo "STRIPE_LIVE_ACTIVATION=NO"
echo "PM2_POSTGRES_REDIS_CLOUDFLARE=NOT_MODIFIED"
