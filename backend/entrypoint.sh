#!/bin/sh
set -eu

# Explicit commands (for example the maintenance worker) bypass API startup.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

# Never mutate production schema merely because an API container restarted.
# Run migrations as a separate approved release step after backup verification.
# Python Settings normalizes case and whitespace; the shell startup must agree.
# Otherwise ENVIRONMENT=PRODUCTION could silently auto-migrate production.
environment_normalized=$(printf '%s' "${ENVIRONMENT:-development}" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
if [ "$environment_normalized" = "production" ]; then
  # The startup path never performs production migrations, including when an
  # older release environment still carries AUTO_MIGRATE_ON_START=true.
  # Refuse a contradictory configuration rather than silently starting with
  # an unexpected schema. Explicit CLI maintenance commands are handled above.
  migrate_flag=$(printf '%s' "${AUTO_MIGRATE_ON_START:-false}" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  case "$migrate_flag" in
    1|true|yes|on)
      echo "[Tala Eats] ERROR: AUTO_MIGRATE_ON_START no se admite en producción; use un job de migración separado y aprobado" >&2
      exit 78
      ;;
  esac
  echo "[Tala Eats] Migraciones automáticas deshabilitadas en producción"
elif [ "${AUTO_MIGRATE_ON_START:-true}" = "true" ]; then
  echo "[Tala Eats] Aplicando migraciones locales/de QA..."
  alembic upgrade head
else
  echo "[Tala Eats] Migración automática deshabilitada"
fi
# Bootstrap is a privileged one-time operation, NEVER part of production
# API startup or a container restart. In development it is explicitly opt-in.
if [ "$environment_normalized" != "production" ] && [ "${BOOTSTRAP_ADMIN_ENABLED:-false}" = "true" ]; then
  python -m app.bootstrap_admin
else
  echo "[Tala Eats] Admin bootstrap no se ejecuta en arranque normal"
fi

echo "[Tala Eats] Iniciando API production hardened..."
exec uvicorn app.main:app \
  --host 0.0.0.0 \
  --port 8000 \
  --workers "${WEB_CONCURRENCY:-4}" \
  --proxy-headers \
  --forwarded-allow-ips="${UVICORN_FORWARDED_ALLOW_IPS:-127.0.0.1}" \
  --timeout-keep-alive "${UVICORN_KEEP_ALIVE:-5}" \
  --timeout-graceful-shutdown "${UVICORN_GRACEFUL_SHUTDOWN:-25}" \
  --timeout-worker-healthcheck "${UVICORN_WORKER_HEALTHCHECK:-10}" \
  --backlog "${UVICORN_BACKLOG:-4096}" \
  --limit-concurrency "${UVICORN_LIMIT_CONCURRENCY:-800}" \
  --limit-max-requests "${UVICORN_MAX_REQUESTS:-50000}"
