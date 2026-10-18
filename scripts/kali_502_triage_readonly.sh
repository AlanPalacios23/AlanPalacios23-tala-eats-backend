#!/usr/bin/env bash
# TALA EATS -- READ-ONLY 502 triage. Intended for existing Kali host.
# No sudo, no Docker restarts, no env/config/secrets reads or modifications.
set -Eeuo pipefail
export LC_ALL=C
printf 'TALA_502_TRIAGE_BEGIN\n'
for name in talaeats-v3-backend-1 talaeats-v3-caddy-1 talaeats-green-api-1 talaeats-green-db-1 talaeats-green-redis-1 talaeats-v3-db-1 talaeats-v3-redis-1; do
  if ! docker inspect --type container "$name" >/dev/null 2>&1; then
    printf 'CONTAINER_ABSENT %s\n' "$name"
    continue
  fi
  state="$(docker inspect --format '{{.State.Status}}' "$name" 2>/dev/null || true)"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}not-configured{{end}}' "$name" 2>/dev/null || true)"
  restarts="$(docker inspect --format '{{.RestartCount}}' "$name" 2>/dev/null || true)"
  exitcode="$(docker inspect --format '{{.State.ExitCode}}' "$name" 2>/dev/null || true)"
  oom="$(docker inspect --format '{{.State.OOMKilled}}' "$name" 2>/dev/null || true)"
  printf 'CONTAINER %s state=%s health=%s restarts=%s exit=%s oom=%s\n' "$name" "$state" "$health" "$restarts" "$exitcode" "$oom"
done

printf '%s\n' '--- Known local HTTP routes (HTTP status only, no response bodies) ---'
for suffix in /api/v1/health /api/v1/ready; do
  result="$(curl --silent --show-error --max-time 7 --output /dev/null \
    --write-out '%{http_code}' -H 'Host: talaeats.alan-palacios-dev.com' \
    "http://127.0.0.1:8082$suffix" 2>/dev/null || true)"
  printf 'V3_CADDY_LOCAL_HTTP %s %s\n' "$suffix" "${result:-unreachable}"
done
for suffix in /api/v1/health /api/v1/ready; do
  result="$(curl --silent --show-error --max-time 10 --output /dev/null \
    --write-out '%{http_code}' \
    "https://talaeats.alan-palacios-dev.com$suffix" 2>/dev/null || true)"
  printf 'CLOUDFLARE_PUBLIC_HTTP %s %s\n' "$suffix" "${result:-unreachable}"
done

printf '%s\n' '--- Published Docker ports (ports only, no config/env values) ---'
for name in talaeats-v3-caddy-1 talaeats-v3-backend-1 talaeats-green-api-1; do
  if docker inspect --type container "$name" >/dev/null 2>&1; then
    docker port "$name" 2>/dev/null | while IFS= read -r line; do
      printf 'PORT %s %s\n' "$name" "$line"
    done
  fi
done

printf '%s\n' '--- V3 backend last 120 log lines (error TYPES only, no content) ---'
# Raw logs NEVER reach the user output: this classifier only emits fixed safe tags.
if docker inspect --type container talaeats-v3-backend-1 >/dev/null 2>&1; then
  docker logs --tail 120 talaeats-v3-backend-1 2>&1 | python3 -c '
import re,sys
s=sys.stdin.read(250000)
markers={
  "PYTHON_TRACEBACK":r"Traceback \(most recent call last\)",
  "PYTHON_IMPORT_ERROR":r"ModuleNotFoundError|ImportError",
  "ALEMBIC_OR_MIGRATION":r"alembic|migration|revision",
  "POSTGRES_CONNECTION_ERROR":r"psycopg|could not connect to server|connection refused",
  "REDIS_CONNECTION_ERROR":r"redis.*(?:error|refused|connect)",
  "APPLICATION_CONFIG_ERROR":r"STAGE_MODE_INVALID|DATABASE_URL|JWT_SECRET|ValidationError",
  "PORT_BIND_ERROR":r"Address already in use",
  "PROCESS_EXIT":r"Application startup failed|exited with code",
}
for name,pattern in markers.items():
    if re.search(pattern,s,re.IGNORECASE):
        print("LOG_CLASSIFICATION "+name)
found=re.findall(r"(?m)^\s*(?:[a-zA-Z_]\w*\.)*([A-Za-z_]\w*(?:Error|Exception))\s*:",s)
for name in sorted(set(found)):
    if re.fullmatch(r"[A-Za-z_]\w{0,50}",name):
        print("EXCEPTION_TYPE "+name)
if not s.strip():
    print("LOG_CLASSIFICATION NO_LOGS")
print("RAW_LOGS_NOT_PRINTED")
'
fi
printf 'TALA_502_TRIAGE_END_READONLY\n'
