#!/usr/bin/env bash
# RC8.9 READ ONLY after an independently approved Kali stage promotion.
# Does NOT deploy, modify PM2, activate Stripe, migrate, or write to PG.
set -Eeuo pipefail
set +x
umask 077
[[ "$#" -eq 1 && "$1" =~ ^[a-f0-9]{40}$ ]] || {
  echo "USAGE: bash scripts/rc89-stage-postdeploy-check.sh <FULL_SHA>"; exit 2;
}
SHA="$1"
[[ "$(id -un)" == "tala-node-stage" && "$(id -u)" != 0 &&
   "$HOME" == "/home/tala-node-stage" ]] || {
  echo "RC89_STAGE_ACCOUNT_REQUIRED"; exit 1;
}
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
command -v node >/dev/null 2>&1 || { echo "RC89_NODE24_REQUIRED"; exit 1; }
node -e 'const v=process.versions.node.split(".").map(Number);process.exit(v[0]===24?0:1)' ||
 { echo "RC89_NODE24_REQUIRED"; exit 1; }
ENV="$HOME/.config/talaeats-node-staging.env"
RELEASE="$HOME/tala-node-releases/$SHA"
WORK="$RELEASE/node-backend"
[[ -f "$ENV" && ! -L "$ENV" &&
   "$(stat -c '%a' "$ENV")" == 600 &&
   "$(stat -c '%u' "$ENV")" == "$(id -u)" ]] || {
 echo "RC89_PRIVATE_STAGE_ENV_REQUIRED"; exit 1;
}
[[ -d "$WORK" && ! -L "$RELEASE" && ! -L "$WORK" &&
   -f "$WORK/scripts/rc89-postdeploy-dispatch-audit.mjs" ]] || {
 echo "RC89_RELEASE_DIR_MISSING"; exit 1;
}
[[ "$(git -C "$RELEASE" rev-parse --verify HEAD 2>/dev/null)" == "$SHA" ]] || {
 echo "RC89_SOURCE_SHA_MISMATCH"; exit 1;
}
cd "$WORK"
# Node --env-file parses a 0600 file without sourcing shell code.
# NODE_ENV is re-validated as 'staging' by the audit.
exec node --env-file="$ENV" scripts/rc89-postdeploy-dispatch-audit.mjs \
  --stage-sha "$SHA"
