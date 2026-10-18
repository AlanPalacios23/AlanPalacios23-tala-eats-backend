#!/usr/bin/env bash
# Loads only a local 0600 environment file and starts the Python API or worker.
set -Eeuo pipefail
umask 077
# shellcheck source=deploy/pm2/validate-stage.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/validate-stage.sh"
case "${1:-}" in
  api)
    exec .venv/bin/python -m uvicorn app.main:app \
      --host 127.0.0.1 --port 18090 --workers 2 \
      --proxy-headers --forwarded-allow-ips 127.0.0.1 \
      --timeout-graceful-shutdown 25
    ;;
  worker)
    exec .venv/bin/python -m app.worker
    ;;
  *)
    echo "Usage: run-python.sh api|worker" >&2
    exit 2
    ;;
esac
