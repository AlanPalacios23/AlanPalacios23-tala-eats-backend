#!/usr/bin/env bash
# Installs verified official Node 24 and pinned PM2 under tala-node-stage HOME.
# No sudo, no system packages, no Docker, no PM2 app started.
set -euo pipefail
MODE='--plan'
if [ "$#" -gt 0 ]; then MODE="$1"; fi
if [ "$MODE" != '--plan' ] && [ "$MODE" != '--apply' ]; then
  echo 'USAGE --plan|--apply'; exit 2
fi
echo 'TALA_NODE24_USER_INSTALL_BEGIN'
if [ "$(id -un)" != 'tala-node-stage' ] || [ "$(id -u)" -eq 0 ]; then
  echo 'ABORT_RUN_AS_TALA_NODE_STAGE'; exit 1
fi
case "$(uname -m)" in
  x86_64) ARCH=x64 ;;
  aarch64) ARCH=arm64 ;;
  *) echo 'ABORT_UNSUPPORTED_ARCH'; exit 1 ;;
esac
for tool in curl tar sha256sum grep mktemp; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ABORT_TOOL_MISSING_$tool"; exit 1; }
done
DEST="$HOME/.local/node24"
if [ -e "$DEST" ]; then
  echo 'ABORT_NODE24_TARGET_ALREADY_EXISTS'; exit 1
fi
echo "NODE_PLATFORM=linux-$ARCH"
echo 'TARGET_USER=tala-node-stage'
if [ "$MODE" = '--plan' ]; then
  echo 'PLAN_ONLY_NO_CHANGES'
  echo 'TALA_NODE24_USER_INSTALL_END'
  exit 0
fi
if [ "$(printenv TALA_NODE24_USER_APPROVAL 2>/dev/null || true)" != 'I_APPROVE_STAGE_USER_ONLY' ]; then
  echo 'ABORT_EXPLICIT_APPROVAL_REQUIRED'; exit 1
fi

umask 077
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
BASE='https://nodejs.org/dist/latest-v24.x'
curl -fsS --proto '=https' --tlsv1.2 "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
NAME="$(grep -Eo "node-v24[.][0-9]+[.][0-9]+-linux-$ARCH[.]tar[.]xz" "$TMP/SHASUMS256.txt" | head -n 1)"
if [ -z "$NAME" ]; then echo 'ABORT_NODE24_ARCHIVE_MISSING'; exit 1; fi
curl -fsS --proto '=https' --tlsv1.2 "$BASE/$NAME" -o "$TMP/$NAME"
HASH_LINE="$(grep -F "  $NAME" "$TMP/SHASUMS256.txt" | head -n 1)"
if [ -z "$HASH_LINE" ]; then echo 'ABORT_CHECKSUM_MISSING'; exit 1; fi
if ! printf '%s\n' "$HASH_LINE" | (cd "$TMP" && sha256sum --check --status); then
  echo 'ABORT_NODE_TARBALL_CHECKSUM'; exit 1
fi
echo 'OFFICIAL_NODE_SHA256=PASS'
mkdir -p -m 0700 "$HOME/.local"
mkdir -m 0700 "$DEST"
tar -xJf "$TMP/$NAME" --strip-components=1 -C "$DEST"
export PATH="$DEST/bin:$HOME/.local/bin:$PATH"
export NPM_CONFIG_PREFIX="$HOME/.local"
node -e 'const [maj,min]=process.versions.node.split(".").map(Number);if(maj!==24||min<11)process.exit(1)' || {
  echo 'ABORT_WRONG_NODE_VERSION'; exit 1;
}
# Scoped installation: DOES NOT update the system Node or start PM2 apps.
npm install --global --no-audit --no-fund 'pm2@6.0.14' >/dev/null
test -x "$HOME/.local/bin/pm2" || { echo 'ABORT_PM2_BIN_MISSING'; exit 1; }
if ! grep -Fq 'TALA_NODE24_STAGE_PATH' "$HOME/.profile" 2>/dev/null; then
  printf '\n# TALA_NODE24_STAGE_PATH\nexport PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"\n' >> "$HOME/.profile"
fi
echo 'NODE24_STAGE_USER=PASS'
echo 'PM2_6_0_14_STAGE_USER=PASS'
echo 'STAGING_PM2_APPS_NOT_STARTED=yes'
echo 'TALA_NODE24_USER_INSTALL_END'
