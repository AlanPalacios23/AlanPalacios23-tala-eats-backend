#!/usr/bin/env bash
# Read-only host inventory. No services altered.
set -euo pipefail
echo TALA_NODE_NATIVE_PREFLIGHT_BEGIN
for c in node npm pm2 psql pg_lsclusters redis-server redis-cli ss git; do
  if command -v "$c" >/dev/null 2>&1; then
    echo "COMMAND_$c=present"
  else
    echo "COMMAND_$c=missing"
  fi
done
if command -v node >/dev/null 2>&1; then
  node -e 'let a=process.versions.node.split(".").map(Number);console.log("NODE24_OK="+(a[0]===24&&a[1]>=11?"yes":"no"))'
fi
for port in 15435 16379 18190; do
  if command -v ss >/dev/null 2>&1 && ss -ltn | awk '{print $4}' | grep -Eq ":$port$"; then
    echo "STAGING_PORT_$port=occupied_CHECK_OWNER"
  else
    echo "STAGING_PORT_$port=free_or_unknown"
  fi
done
echo EXISTING_V3_GREEN_UNMODIFIED=yes
echo TALA_NODE_NATIVE_PREFLIGHT_END
