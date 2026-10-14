#!/bin/sh
set -eu

# Explicit commands (for example the maintenance worker) bypass API startup.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

echo "[Tala Eats] Aplicando migraciones..."
alembic upgrade head
python -m app.bootstrap_admin

echo "[Tala Eats] Iniciando API production hardened..."
exec uvicorn app.main:app \
  --host 0.0.0.0 \
  --port 8000 \
  --workers "${WEB_CONCURRENCY:-4}" \
  --proxy-headers \
  --forwarded-allow-ips="*" \
  --timeout-keep-alive "${UVICORN_KEEP_ALIVE:-5}" \
  --timeout-graceful-shutdown "${UVICORN_GRACEFUL_SHUTDOWN:-25}" \
  --timeout-worker-healthcheck "${UVICORN_WORKER_HEALTHCHECK:-10}" \
  --backlog "${UVICORN_BACKLOG:-4096}" \
  --limit-concurrency "${UVICORN_LIMIT_CONCURRENCY:-800}" \
  --limit-max-requests "${UVICORN_MAX_REQUESTS:-50000}"
