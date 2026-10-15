#!/usr/bin/env bash
# TALA EATS: descubrimiento de despliegue/rollback, SOLO LECTURA.
# Nunca ejecuta docker compose up/down/restart, docker build, pg_dump o cambios de Stripe.
# No consulta variables de entorno de contenedores, .env, SQL ni configuración privada.
set -euo pipefail

API="talaeats-v3-backend-1"
EXPECTED_PROJECT="talaeats-v3"
READY_URL="http://127.0.0.1:8082/api/v1/ready"

section() { printf '\n=== %s ===\n' "$1"; }
require() { command -v "$1" >/dev/null 2>&1 || { echo "Falta: $1" >&2; exit 2; }; }
require docker
require python3
require curl
require git

if ! docker inspect --type container "$API" >/dev/null 2>&1; then
  echo "DENEGADO: contenedor de producción no localizado: $API" >&2
  exit 2
fi

PROJECT="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$API")"
SERVICE="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$API")"
if [[ "$PROJECT" != "$EXPECTED_PROJECT" || "$SERVICE" != "backend" ]]; then
  echo "DENEGADO: etiquetas Compose inesperadas: proyecto=$PROJECT servicio=$SERVICE" >&2
  exit 2
fi

section "Fecha y espacio (sin secretos)"
date -u '+%Y-%m-%d %H:%M:%S UTC'
df -h /home | tail -n 1

section "Compose identificado por etiquetas de Docker"
printf 'Proyecto: %s\nServicio API: %s\n' "$PROJECT" "$SERVICE"
printf 'Directorio de proyecto: '
docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$API"
printf 'Archivos Compose: '
docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$API"
printf 'Imagen declarada: '
docker inspect --format '{{.Config.Image}}' "$API"
printf 'ID de imagen exacta: '
docker inspect --format '{{.Image}}' "$API"
printf 'Estado y salud: '
docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}sin-healthcheck{{end}}' "$API"

section "Servicios de este proyecto (sólo nombres, imagen y estado)"
docker ps -a --filter "label=com.docker.compose.project=$EXPECTED_PROJECT" \
  --format '{{.Names}} | {{.Image}} | {{.Status}}'

section "Volúmenes asociados a API (sin rutas origen ni contenido)"
docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}VOLUMEN {{.Name}} -> {{.Destination}}{{else}}MOUNT {{.Type}} -> {{.Destination}}{{end}}{{println}}{{end}}' "$API"

section "Versión y salud HTTP (campos explícitamente permitidos)"
curl -fsS --max-time 12 "$READY_URL" | python3 -c '
import json,sys
x=json.load(sys.stdin)
allowed=("version","ready","database","redis","worker")
for k in allowed:
    if k in x:
        print(f"{k}={x[k]}")
if x.get("ready") is not True:
    raise SystemExit("DENEGADO: la API no reporta ready=true")
'

section "Migraciones activas, sólo lectura"
docker exec -w /app "$API" alembic current
docker exec -w /app "$API" alembic heads

section "Identidad de checkout auditado (no altera git)"
REPO="$HOME/tala-backend-audit"
if [[ -d "$REPO/.git" ]]; then
  git -C "$REPO" rev-parse --verify HEAD
  git -C "$REPO" status --short -- backend/app backend/migrations backend/entrypoint.sh backend/requirements.txt
else
  printf 'Checkout aún no disponible en %s\n' "$REPO"
fi

section "Resultado"
printf 'INVENTARIO_SOLO_LECTURA_PASS\n'
printf 'No constituye autorización para desplegar ni para revertir migraciones.\n'
printf 'NO se ha realizado backup, deploy, rollback, reinicio, transferencia ni retiro.\n'
printf 'Revisar la salida antes de compartirla (incluye nombres y rutas de Compose).\n'
