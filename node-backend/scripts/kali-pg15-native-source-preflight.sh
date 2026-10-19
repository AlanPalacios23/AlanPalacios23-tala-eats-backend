#!/usr/bin/env bash
# Read-only Kali PostgreSQL15 source build prerequisites, no apt or Docker.
set -euo pipefail
echo TALA_NATIVE_PG15_SOURCE_PREFLIGHT_BEGIN
if [ -r /etc/os-release ] && grep -Eq '^ID="?kali"?$' /etc/os-release; then
  echo OS_KALI=yes
else
  echo OS_KALI=unconfirmed
fi
case "$(uname -m)" in
  x86_64|aarch64) echo ARCH_SUPPORTED=yes ;;
  *) echo ARCH_SUPPORTED=no ;;
esac
ready=yes
for tool in gcc make tar curl sha256sum gzip sed awk install; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "TOOL_$tool=present"
  else
    echo "TOOL_$tool=missing"
    ready=no
  fi
done
for pkg in build-essential libreadline-dev zlib1g-dev libssl-dev ca-certificates; do
  if dpkg-query -W "$pkg" >/dev/null 2>&1; then
    echo "BUILD_PACKAGE_$pkg=installed"
  else
    echo "BUILD_PACKAGE_$pkg=not_installed"
  fi
done
if [ -x /usr/lib/postgresql/15/bin/postgres ]; then
  echo PG15_APT_BINARY_PRESENT=yes
else
  echo PG15_APT_BINARY_PRESENT=no
fi
if command -v pg_lsclusters >/dev/null 2>&1; then
  echo EXISTING_CLUSTERS_READONLY=yes
  pg_lsclusters --no-header 2>/dev/null | awk '{print "CLUSTER=" $1 "/" $2 " PORT=" $3 " STATUS=" $4}' || true
fi
if command -v ss >/dev/null 2>&1; then
  for port in 15435 16379 18190; do
    if ss -H -ltn | awk '{print $4}' | grep -Eq ":$port$"; then
      echo "STAGE_PORT_$port=occupied"
      ready=no
    else
      echo "STAGE_PORT_$port=free"
    fi
  done
fi
available="$(df -Pk "$HOME" | awk 'NR==2 {print $4}')"
if [ "$available" -ge 1048576 ] 2>/dev/null; then
  echo SOURCE_BUILD_SPACE_1G=yes
else
  echo SOURCE_BUILD_SPACE_1G=no
  ready=no
fi
if [ "$ready" = yes ]; then
  echo SOURCE_BUILD_TOOLCHAIN_READY=yes
else
  echo SOURCE_BUILD_TOOLCHAIN_READY=no
fi
echo PG15_SOURCE_VERSION_PLANNED=15.19
echo NO_PACKAGES_INSTALLED_NO_SERVICES_CHANGED=yes
echo TALA_NATIVE_PG15_SOURCE_PREFLIGHT_END
