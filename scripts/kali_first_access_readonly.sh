#!/usr/bin/env bash
# TALA EATS Kali host inventory — READ-ONLY (safe alongside Docker LIVE).
# No sudo, package install, service restart, Git pull or credentials.
set -Eeuo pipefail
export LC_ALL=C
echo 'TALA_KALI_PREFLIGHT_BEGIN'
printf 'UNAME='; uname -sr 2>/dev/null || true
printf 'UPTIME='; uptime -p 2>/dev/null || true
printf 'USER_IS_ROOT='
if [[ "$(id -u)" == "0" ]]; then echo yes; else echo no; fi
echo '--- CPU / RAM / DISK ---'
nproc 2>/dev/null | awk '{print "CPUS=" $1}' || true
free -h 2>/dev/null || true
df -h / 2>/dev/null || true
echo '--- TOOL AVAILABILITY (paths only, no credentials) ---'
for cmd in git curl python3 python3.13 node npm pm2 docker psql pg_isready redis-cli cloudflared caddy ss; do
  if command -v "$cmd" >/dev/null 2>&1; then
    printf 'TOOL_PRESENT %s\n' "$cmd"
  else
    printf 'TOOL_MISSING %s\n' "$cmd"
  fi
done
echo '--- LOCAL LISTENING PORTS (addresses only, no PIDs) ---'
if command -v ss >/dev/null 2>&1; then
  ss -H -lnt 2>/dev/null | awk '
    {
      p=$4
      sub(/^.*:/,"",p)
      if (p ~ /^(22|80|443|5432|5433|6379|6380|6381|8000|8080|8082|18090)$/) {
        printf "LISTEN %s\n", $4
      }
    }' | sort -u || true
fi
echo '--- SERVICE STATES (read-only) ---'
if command -v systemctl >/dev/null 2>&1; then
  for svc in docker caddy cloudflared postgresql redis-server ssh; do
    state="$(systemctl is-active "$svc.service" 2>/dev/null || true)"
    if [[ -z "$state" ]]; then state=unknown; fi
    printf 'SERVICE %s %s\n' "$svc" "$state"
  done
fi
echo '--- RUNNING CONTAINERS (names/status only; no inspect/env) ---'
if command -v docker >/dev/null 2>&1; then
  if docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; then
    docker ps --format 'CONTAINER {{.Names}} | {{.Status}}' 2>/dev/null || true
  else
    echo 'DOCKER_INVENTORY_UNAVAILABLE'
  fi
fi
echo '--- STAGING USER (existence only) ---'
if getent passwd talaeats-stage >/dev/null 2>&1; then
  echo 'STAGING_USER_PRESENT'
else
  echo 'STAGING_USER_MISSING'
fi
echo '--- PUBLIC HEALTH STATUS (GET only; no body) ---'
if command -v curl >/dev/null 2>&1; then
  for endpoint in health ready; do
    status="$(curl --silent --show-error --location --max-time 8 --output /dev/null \
      --write-out '%{http_code}' \
      "https://talaeats.alan-palacios-dev.com/api/v1/$endpoint" 2>/dev/null || true)"
    if [[ -z "$status" ]]; then status=network-error; fi
    printf 'PUBLIC_%s_HTTP %s\n' "$endpoint" "$status"
  done
fi
echo 'TALA_KALI_PREFLIGHT_END_READONLY'
