#!/usr/bin/env bash
# TALA EATS — clean backend from GitHub main@d584e2d, isolated from LIVE.
# --launch creates a NEW Compose project with empty PG16/Redis/media volumes.
# DO NOT switch domain, restore, wipe old volumes, touch old container or Stripe.
set -Eeuo pipefail
umask 077

SHA="d584e2dcad91c46b2dfa2834343d5f7562486bca"
IMAGE="talaeats-candidate:${SHA}"
PROJECT="talaeats-green"
DIR="$HOME/talaeats-green-20261018"
READY="http://127.0.0.1:18182/api/v1/ready"
EXPECTED="1.6.4-connect-selfservice-hf1"
old_backend="talaeats-v3-backend-1"
old_db="talaeats-v3-db-1"

case "${1:-}" in
  --self-test)
    [[ "$PROJECT" != "talaeats-v3" && "$DIR" == "$HOME/talaeats-green-20261018" ]]
    [[ "$READY" == http://127.0.0.1:18182/* ]]
    echo "KALI_GREEN_BOOT_SAFETY_SELFTEST_PASS"
    exit 0 ;;
  --launch) MODE=launch ;;
  --resume) MODE=resume ;;
  *) echo "Uso: bash kali_clean_green_boot.sh --launch|--resume|--self-test"; exit 2 ;;
esac

for executable in docker python3; do
  command -v "$executable" >/dev/null || { echo "Falta: $executable"; exit 2; }
done
docker compose version >/dev/null

# This is the approved main image built BEFORE the failed promotion.
actual="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE" 2>/dev/null || true)"
[[ "$actual" == "$SHA" ]] || {
  echo "ABORT: imagen Docker de GitHub no existe o tiene SHA distinto; NO reconstruir desde otra fuente"
  exit 2
}
[[ "$(docker image inspect --format '{{.Config.User}}' "$IMAGE")" == "talaeats" ]] || {
  echo "ABORT: imagen no es non-root"
  exit 2
}
docker inspect "$old_db" --format '{{index .Config.Labels "com.docker.compose.project"}}' |
  grep -qx "talaeats-v3" || { echo "ABORT: el proyecto antiguo cambió"; exit 2; }

if [[ "$MODE" == "resume" ]]; then
  # Do not regenerate secrets, overwrite files or discard volumes.
  [[ -d "$DIR" && -f "$DIR/compose.yml" && -f "$DIR/green.env" &&
     ! -L "$DIR" && ! -L "$DIR/green.env" ]] || {
    echo "ABORT: falta la instalación verde anterior; no crear/limpiar automáticamente"
    exit 2
  }
  python3 - "$DIR/green.env" <<'PY'
from pathlib import Path
import sys
rows = Path(sys.argv[1]).read_text().splitlines()
env = dict(row.split("=", 1) for row in rows if "=" in row)
for key, expected in {
    "ENVIRONMENT": "production",
    "SEED_DEMO_DATA": "false",
    "BOOTSTRAP_ADMIN_ENABLED": "false",
    "AUTO_MIGRATE_ON_START": "false",
    "STRIPE_ENABLED": "false",
    "WITHDRAWALS_EXECUTION_ENABLED": "false",
    "WITHDRAWALS_LIVE_ENABLED": "false",
}.items():
    if env.get(key) != expected:
        raise SystemExit("GREEN_RESUME_ABORT: configuración inesperada en " + key)
if env.get("DATABASE_URL", "").split("@")[-1] != "db:5432/tala_green":
    raise SystemExit("GREEN_RESUME_ABORT: DB no apunta al proyecto verde")
print("GREEN_RESUME_NO_DEMOS_CONFIG_PASS")
PY
fi

if [[ "$MODE" == "launch" ]]; then
# No overwrites or replacement of an existing green instance.
[[ ! -e "$DIR" ]] || {
  echo "ABORT: carpeta green ya existe, se conserva sin sobrescribir. Revisa el estado manualmente."
  exit 2
}
if docker network ls --format '{{.Name}}' | grep -qx 'talaeats-green_default'; then
  echo "ABORT: proyecto green previo detectado, no se sobrescribe"
  exit 2
fi
if docker volume ls --format '{{.Name}}' | grep -E '^talaeats-green_' >/dev/null; then
  echo "ABORT: volúmenes green ya existen, no se sobrescriben"
  exit 2
fi
if ! python3 - <<'PY'
import socket
with socket.socket() as sock:
    try:
        sock.bind(("127.0.0.1", 18182))
    except OSError:
        raise SystemExit(1)
PY
then
  echo "ABORT: puerto loopback 18182 no está libre"
  exit 2
fi

mkdir -m 0700 "$DIR"
cat > "$DIR/compose.yml" <<'YAML'
name: talaeats-green

services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: tala_green
      POSTGRES_DB: tala_green
      POSTGRES_PASSWORD: "${GREEN_POSTGRES_PASSWORD:?missing}"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U tala_green -d tala_green"]
      interval: 5s
      timeout: 3s
      retries: 25

  redis:
    image: redis:8-alpine
    command: ["redis-server", "--appendonly", "yes"]
    restart: unless-stopped
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 20

  migrate:
    image: talaeats-candidate:d584e2dcad91c46b2dfa2834343d5f7562486bca
    pull_policy: never
    env_file: green.env
    command: ["alembic", "upgrade", "head"]
    profiles: ["migration"]
    depends_on:
      db:
        condition: service_healthy

  api:
    image: talaeats-candidate:d584e2dcad91c46b2dfa2834343d5f7562486bca
    pull_policy: never
    restart: unless-stopped
    env_file: green.env
    ports:
      - "127.0.0.1:18182:8000"
    volumes:
      - media:/app/media
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "python", "-c", "import json,urllib.request; x=json.load(urllib.request.urlopen('http://127.0.0.1:8000/api/v1/ready',timeout=5)); assert x['ready'] is True"]
      interval: 10s
      timeout: 7s
      retries: 15
      start_period: 20s

  worker:
    image: talaeats-candidate:d584e2dcad91c46b2dfa2834343d5f7562486bca
    pull_policy: never
    restart: unless-stopped
    env_file: green.env
    command: ["python", "-m", "app.worker"]
    volumes:
      - media:/app/media
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy

volumes:
  pgdata:
  redisdata:
  media:
YAML

# Generate random secrets locally. Neither terminal nor GitHub receives them.
python3 - "$DIR/green.env" <<'PY'
import os, pathlib, secrets, sys
path = pathlib.Path(sys.argv[1])
pg = secrets.token_hex(24)
jwt = secrets.token_hex(48)
lines = {
    "GREEN_POSTGRES_PASSWORD": pg,
    "ENVIRONMENT": "production",
    "DEBUG": "false",
    "DATABASE_URL": f"postgresql+psycopg://tala_green:{pg}@db:5432/tala_green",
    "REDIS_URL": "redis://redis:6379/0",
    "JWT_SECRET": jwt,
    "ALLOWED_HOSTS": "127.0.0.1,localhost,talaeats.alan-palacios-dev.com",
    "CORS_ORIGINS": "https://talaeats.alan-palacios-dev.com,https://admin-talaeats.alan-palacios-dev.com",
    "PUBLIC_BASE_URL": "https://talaeats.alan-palacios-dev.com",
    "FRONTEND_URL": "https://talaeats.alan-palacios-dev.com",
    "MEDIA_DIR": "/app/media",
    "SEED_DEMO_DATA": "false",
    "BOOTSTRAP_ADMIN_ENABLED": "false",
    "AUTO_MIGRATE_ON_START": "false",
    "DOCS_ENABLED": "false",
    "REQUIRE_ONLINE_PAYMENTS": "false",
    "STRIPE_ENABLED": "false",
    "STRIPE_CONNECT_ENABLED": "false",
    "STRIPE_CONNECT_SELF_SERVICE_ENABLED": "false",
    "WITHDRAWALS_PREVIEW_ENABLED": "false",
    "WITHDRAWALS_EXECUTION_ENABLED": "false",
    "WITHDRAWALS_LIVE_ENABLED": "false",
    "REQUIRE_PAYOUT_PROVIDER": "false",
    "NATIVE_PUSH_ENABLED": "false",
    "REQUIRE_SMTP": "false",
    "UVICORN_FORWARDED_ALLOW_IPS": "127.0.0.1",
    "WEB_CONCURRENCY": "2",
    "WORKER_INTERVAL_SECONDS": "30",
    "DRIVER_OFFER_MODE": "false",
    "MERCHANT_MANAGED_DELIVERY": "false",
}
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as f:
    for k, v in lines.items():
        f.write(f"{k}={v}\n")
print("GREEN_LOCAL_SECRETS_CREATED (no se muestran)")
PY
fi

compose() {
  docker compose -p "$PROJECT" --project-directory "$DIR" --env-file "$DIR/green.env" -f "$DIR/compose.yml" "$@"
}

echo "Iniciando PostgreSQL/Redis NUEVOS, proyecto aislado..."
compose up -d --no-build db redis
for i in {1..50}; do
  d="$(docker inspect "${PROJECT}-db-1" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}unknown{{end}}' 2>/dev/null || true)"
  r="$(docker inspect "${PROJECT}-redis-1" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}unknown{{end}}' 2>/dev/null || true)"
  [[ "$d" == healthy && "$r" == healthy ]] && break
  sleep 3
done
[[ "$d" == healthy && "$r" == healthy ]] || { echo "GREEN_DEPENDENCIES_NOT_READY"; exit 2; }

echo "Verificando conexión desde el contenedor migrador al PostgreSQL verde..."
probe=0
for attempt in {1..12}; do
  if compose --profile migration run --rm migrate python -c \
    'import os,psycopg;psycopg.connect(os.environ["DATABASE_URL"].replace("postgresql+psycopg://","postgresql://"),connect_timeout=4).close()' \
    >/dev/null 2>&1; then
    probe=1
    break
  fi
  sleep 5
done
[[ "$probe" == "1" ]] || {
  echo "GREEN_DB_FROM_MIGRATOR_UNREACHABLE: abortado sin modificar producción"
  exit 2
}
echo "GREEN_DB_NETWORK_PASS"
echo "Aplicando migraciones SOLO sobre la base green..."
compose --profile migration run --rm migrate

echo "Confirmando que no existen usuarios, restaurantes ni pedidos..."
counts="$(compose exec -T db psql -X -qAt -v ON_ERROR_STOP=1 -U tala_green -d tala_green -c "SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM restaurants), (SELECT count(*) FROM orders)")"
[[ "$counts" == "0|0|0" ]] || {
  echo "GREEN_NOT_EMPTY_ABORT: los conteos no son todos cero, no iniciar API"
  exit 2
}
ver="$(compose exec -T db psql -X -qAt -v ON_ERROR_STOP=1 -U tala_green -d tala_green -c 'SELECT version_num FROM alembic_version')"
[[ "$ver" == "f21i00000001" ]] || {
  echo "GREEN_SCHEMA_MISMATCH: detener sin tocar LIVE"
  exit 2
}

echo "Iniciando Backend y Worker nuevos (127.0.0.1:18182)..."
compose up -d --no-build api worker

good=0
for i in {1..50}; do
  if python3 - <<'PY'
import json, urllib.request
with urllib.request.urlopen("http://127.0.0.1:18182/api/v1/ready", timeout=4) as r:
    x = json.load(r)
assert x.get("ready") is True and x.get("version") == "1.6.4-connect-selfservice-hf1"
PY
  then
    good=1
    break
  fi
  sleep 3
done

[[ "$good" == "1" ]] || {
  echo "GREEN_API_NOT_READY — Ver: docker compose -p talaeats-green -f ~/talaeats-green-20261018/compose.yml ps"
  echo "No se modificó el servicio anterior. NO usar logs con datos sensibles sin revisar."
  exit 2
}

worker="$(docker inspect talaeats-green-worker-1 --format '{{.State.Status}}' 2>/dev/null || true)"
[[ "$worker" == running ]] || {
  echo "GREEN_WORKER_NOT_RUNNING"
  exit 2
}

echo "KALI_GITHUB_BACKEND_GREEN_READY_PASS"
echo "Version GitHub: ${EXPECTED} SHA: ${SHA}"
echo "DB limpia: users=0, restaurants=0, orders=0; cuentas demo=0"
echo "API local solo Kali: $READY"
echo "No se tocó LIVE, DNS, Caddy, Stripe ni ningún dato anterior."
echo "PENDIENTE: cambio controlado de proxy/dominio tras revisar topología."
