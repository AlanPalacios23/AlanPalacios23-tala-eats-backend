#!/usr/bin/env bash
# PostgreSQL 15.19 official source build. Installs ONLY into stage user's HOME.
# No apt, PG18, Docker, systemd, server startup, DB creation or network bind.
# --plan read-only; --apply must be explicitly approved.
set -euo pipefail
umask 077
MODE='--plan'
if [ "$#" -gt 0 ]; then MODE="$1"; fi
if [ "$MODE" != '--plan' ] && [ "$MODE" != '--apply' ]; then
  echo 'USAGE --plan|--apply'; exit 2
fi
NAME='postgresql-15.19.tar.gz'
VERSION='15.19'
BASE='https://ftp.postgresql.org/pub/source/v15.19'
PREFIX="$HOME/.local/postgresql-15.19"

echo 'TALA_NATIVE_PG15_BUILD_BEGIN'
if [ "$(id -un)" != 'tala-node-stage' ] || [ "$(id -u)" = 0 ]; then
  echo 'ABORT_STAGE_USER_REQUIRED'; exit 1
fi
if [ -e "$PREFIX" ] || [ -L "$PREFIX" ]; then
  echo 'ABORT_PG15_STAGE_PREFIX_ALREADY_EXISTS'; exit 1
fi
for tool in curl sha256sum gcc make tar gzip awk df mktemp; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ABORT_MISSING_TOOL_$tool"; exit 1
  fi
done
if ! dpkg-query -W zlib1g-dev >/dev/null 2>&1; then
  echo 'ABORT_MISSING_ZLIB_HEADERS'; exit 1
fi
FREE_KB="$(df -Pk "$HOME" | awk 'NR==2 {print $4}')"
if [ "$FREE_KB" -lt 1048576 ] 2>/dev/null; then
  echo 'ABORT_DISK_SPACE_LT_1GB'; exit 1
fi
echo 'PG_VERSION_PINNED=15.19'
echo 'TARGET=PRIVATE_STAGE_USER_HOME'
echo 'ZLIB_ARCHIVE_SUPPORT=yes'
echo 'READLINE_SUPPORT=no'
echo 'TLS_REMOTE_SUPPORT=no_LOCAL_ONLY'
if [ "$MODE" = '--plan' ]; then
  echo 'PLAN_ONLY_NO_CHANGES'
  echo 'TALA_NATIVE_PG15_BUILD_END'
  exit 0
fi
if [ "$(printenv TALA_PG15_SOURCE_APPROVAL 2>/dev/null || true)" != 'I_APPROVE_STAGE_HOME_BUILD_ONLY' ]; then
  echo 'ABORT_EXPLICIT_BUILD_APPROVAL'; exit 1
fi

install -d -m 0700 "$HOME/.cache"
TEMP_DIR="$(mktemp -d "$HOME/.cache/tala-pg15-build.XXXXXXXX")"
cleanup() {
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ] && [ -O "$TEMP_DIR" ]; then
    rm -rf -- "$TEMP_DIR"
  fi
}
trap cleanup EXIT
cd "$TEMP_DIR"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --retry 2 --connect-timeout 15 --max-time 180 \
  "$BASE/$NAME.sha256" -o "$NAME.sha256"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --retry 2 --connect-timeout 15 --max-time 300 \
  "$BASE/$NAME" -o "$NAME"
if ! sha256sum -c --status "$NAME.sha256"; then
  echo 'ABORT_OFFICIAL_SOURCE_SHA256_MISMATCH'; exit 1
fi
echo 'PG_SOURCE_SHA256=PASS'
tar -xzf "$NAME" --no-same-owner
if [ ! -x "postgresql-$VERSION/configure" ]; then
  echo 'ABORT_SOURCE_CONFIGURE_NOT_FOUND'; exit 1
fi
cd "postgresql-$VERSION"

# PG15 official docs: --without-readline avoids unavailable readline-devel;
# OpenSSL is opt-in, so absent libssl-dev is fine for LOCAL loopback staging.
# zlib1g-dev remains present and pg_dump custom archive stays supported.
if ! ./configure --prefix="$PREFIX" --without-readline >../configure.log 2>&1; then
  echo 'PG15_CONFIGURE=FAIL'; exit 1
fi
echo 'PG15_CONFIGURE=PASS'
# Low CPU pressure: Kali also hosts existing Docker production services.
if ! make -j1 >../build.log 2>&1; then
  echo 'PG15_MAKE=FAIL'; exit 1
fi
echo 'PG15_MAKE=PASS'
if ! make install >../install.log 2>&1; then
  echo 'PG15_INSTALL=FAIL'; exit 1
fi
if [ ! -x "$PREFIX/bin/postgres" ] || [ ! -x "$PREFIX/bin/initdb" ] ||
   [ ! -x "$PREFIX/bin/pg_ctl" ] || [ ! -x "$PREFIX/bin/psql" ]; then
  echo 'PG15_BINARIES=FAIL'; exit 1
fi
if "$PREFIX/bin/postgres" --version | grep -Eq '^postgres .+ 15[.]19; then
  echo 'PG15_BINARIES=PASS'
else
  echo 'PG15_WRONG_VERSION'; exit 1
fi
echo 'PG15_STAGED_HOME_INSTALL=PASS'
echo 'POSTGRES_CLUSTER_NOT_CREATED=yes'
echo 'NO_DOCKER_PG18_REDIS_OR_STRIPE_CHANGES=yes'
echo 'TALA_NATIVE_PG15_BUILD_END'
; then
  echo 'PG15_BINARIES=PASS'
else
  echo 'PG15_WRONG_VERSION'; exit 1
fi
echo 'PG15_STAGED_HOME_INSTALL=PASS'
echo 'POSTGRES_CLUSTER_NOT_CREATED=yes'
echo 'NO_DOCKER_PG18_REDIS_OR_STRIPE_CHANGES=yes'
echo 'TALA_NATIVE_PG15_BUILD_END'
