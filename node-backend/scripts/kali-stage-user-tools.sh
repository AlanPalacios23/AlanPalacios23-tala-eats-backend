#!/usr/bin/env bash
# TALA EATS / Node native staging. --check = read only.
# --install-user-tools = user-local Node24 and PM2 ONLY; never Docker/apt/sudo.
set -Eeuo pipefail
MODE="--check"
if [ "$#" -gt 0 ]; then MODE="$1"; fi
if [ "$MODE" != "--check" ] && [ "$MODE" != "--install-user-tools" ]; then
  echo "USAGE: bash kali-stage-user-tools.sh [--check|--install-user-tools]"
  exit 2
fi
NODE_VERSION="v24.22.0"
PM2_VERSION="7.0.4"
NODE_PREFIX="$HOME/.local/opt/tala-node-$NODE_VERSION"
NPM_PREFIX="$HOME/.local/share/tala-node-staging-npm"
TOOLS_ENV="$HOME/.config/tala-node-staging-tools.sh"
PM2_STATE="$HOME/.local/share/tala-node-staging-pm2"
echo "TALA_STAGE_USER_TOOLS_BEGIN"
if [ "$(id -u)" = "0" ]; then
  echo "USER_IS_ROOT=yes"
  echo "GATE=BLOCKED"
  exit 1
fi
echo "USER_IS_ROOT=no"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ARCH="x64";;
  Linux-aarch64) ARCH="arm64";;
  *) echo "SUPPORTED_PLATFORM=no"; echo "GATE=BLOCKED"; exit 1;;
esac
echo "SUPPORTED_PLATFORM=yes"
if id -nG | tr ' ' '\n' | grep -qx docker; then
  echo "CURRENT_USER_DOCKER_GROUP=yes"
  if [ "$MODE" = "--install-user-tools" ]; then
    echo "GATE=BLOCKED_USE_SEPARATE_UNPRIVILEGED_STAGE_ACCOUNT"
    exit 1
  fi
else
  echo "CURRENT_USER_DOCKER_GROUP=no"
fi
if [ -x "$NODE_PREFIX/bin/node" ]; then
  "$NODE_PREFIX/bin/node" -e 'let a=process.versions.node.split(".");if(a[0]!=="24")process.exit(1)' ||
    { echo "PINNED_NODE_INVALID"; exit 1; }
  echo "PINNED_NODE_PRESENT=yes"
else
  echo "PINNED_NODE_PRESENT=no"
fi
if [ -x "$NPM_PREFIX/bin/pm2" ]; then
  echo "PINNED_PM2_PRESENT=yes"
else
  echo "PINNED_PM2_PRESENT=no"
fi
for PORT in 15435 16379 18190; do
  if command -v ss >/dev/null 2>&1 && ss -ltnH | awk '{print $4}' | grep -Eq ":$PORT$"; then
    echo "PORT_$PORT=occupied_review_owner"
  else
    echo "PORT_$PORT=free_or_unknown"
  fi
done
if command -v pg_lsclusters >/dev/null 2>&1; then
  echo "NATIVE_POSTGRES_CLUSTER_COMMAND=present"
else
  echo "NATIVE_POSTGRES_CLUSTER_COMMAND=missing"
fi
if command -v apt-cache >/dev/null 2>&1; then
  CANDIDATE="$(apt-cache policy postgresql-15 2>/dev/null | awk '/Candidate:/{print $2;exit}')"
  if [ -n "$CANDIDATE" ] && [ "$CANDIDATE" != "(none)" ]; then
    echo "APT_POSTGRES15_CANDIDATE=yes"
  else
    echo "APT_POSTGRES15_CANDIDATE=no"
  fi
fi
if [ "$MODE" = "--check" ]; then
  echo "GATE=READ_ONLY"
  echo "TALA_STAGE_USER_TOOLS_END"
  exit 0
fi
for DEP in curl tar sha256sum mktemp; do
  command -v "$DEP" >/dev/null 2>&1 || { echo "MISSING_TOOL=$DEP"; exit 1; }
done
umask 077
mkdir -p -m 700 "$HOME/.local/opt" "$HOME/.local/share" "$HOME/.config"
if [ ! -x "$NODE_PREFIX/bin/node" ]; then
  echo "NODE_USER_INSTALL_BEGIN"
  TMP="$(mktemp -d "$HOME/.local/share/tala-node-download-XXXXXXXX")"
  cleanup() { if [ -n "$TMP" ] && [ -d "$TMP" ]; then rm -rf -- "$TMP"; fi; }
  trap cleanup EXIT
  TAR="node-$NODE_VERSION-linux-$ARCH.tar.xz"
  ORIGIN="https://nodejs.org/dist/$NODE_VERSION"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    "$ORIGIN/$TAR" --output "$TMP/$TAR"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    "$ORIGIN/SHASUMS256.txt" --output "$TMP/SHASUMS256.txt"
  (
    cd "$TMP"
    grep -E "^[0-9a-f]{64}  $TAR$" SHASUMS256.txt | sha256sum --check --status
  ) || { echo "NODE_SHA256_VERIFICATION=FAIL"; exit 1; }
  echo "NODE_SHA256_VERIFICATION=PASS"
  tar --extract --xz --file "$TMP/$TAR" --directory "$TMP"
  if [ -e "$NODE_PREFIX" ] || [ -L "$NODE_PREFIX" ]; then
    echo "PINNED_NODE_PATH_ALREADY_EXISTS"; exit 1
  fi
  mv "$TMP/node-$NODE_VERSION-linux-$ARCH" "$NODE_PREFIX"
  echo "NODE_USER_INSTALL=PASS"
fi
export PATH="$NODE_PREFIX/bin:$NPM_PREFIX/bin:$PATH"
export PM2_HOME="$PM2_STATE"
mkdir -p -m 700 "$PM2_HOME" "$NPM_PREFIX"
"$NODE_PREFIX/bin/node" -e 'let a=process.versions.node.split(".");if(a[0]!=="24")process.exit(1)' || exit 1
if [ ! -x "$NPM_PREFIX/bin/pm2" ]; then
  npm install --global --prefix "$NPM_PREFIX" "pm2@$PM2_VERSION" --no-audit --no-fund --ignore-scripts
fi
# Do not edit .bashrc, systemd, sudo, Docker or any production config.
if [ -e "$TOOLS_ENV" ]; then
  echo "TOOLS_ENV_ALREADY_EXISTS_NO_OVERWRITE"
else
  (umask 077; cat > "$TOOLS_ENV" <<'EOF'
# Source only as dedicated native staging user.
export PATH="$HOME/.local/opt/tala-node-v24.22.0/bin:$HOME/.local/share/tala-node-staging-npm/bin:$PATH"
export PM2_HOME="$HOME/.local/share/tala-node-staging-pm2"
EOF
  )
  chmod 600 "$TOOLS_ENV"
fi
echo "NODE_VERSION_EXPECTED=v24.22.0"
echo "PM2_VERSION_PINNED=7.0.4"
echo "STAGE_USER_INSTALL=PASS"
echo "STAGING_DB_REDIS_INSTALLED=no"
echo "PM2_PROCESSES_STARTED=no"
echo "TALA_STAGE_USER_TOOLS_END"
