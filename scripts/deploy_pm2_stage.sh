#!/usr/bin/env bash
# SSH deployment to a separate PM2 staging VPS: git pull -> PM2 reload.
set -Eeuo pipefail
umask 077

expected_sha="${1:-}"
if [[ ! "$expected_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "A full main commit SHA is required" >&2
  exit 2
fi
cd "$HOME/tala-eats-pm2-stage"
if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "This deploy accepts only checked-out main" >&2; exit 2
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Working tree modified; aborting git pull" >&2; exit 2
fi

previous_sha="$(git rev-parse HEAD)"
git fetch --quiet origin main
remote_sha="$(git rev-parse FETCH_HEAD)"
if [[ "$remote_sha" != "$expected_sha" ]]; then
  echo "Newer main exists; refusing stale deployment" >&2; exit 2
fi
if ! git merge-base --is-ancestor "$previous_sha" "$remote_sha"; then
  echo "History is not fast-forward; aborting" >&2; exit 2
fi

# Required local prerequisites before any process restart.
for binary in python3.13 pm2 curl; do
  command -v "$binary" >/dev/null || { echo "Missing $binary" >&2; exit 2; }
done
APP_CONFIG="$HOME/.config/talaeats-pm2-stage.env"
[[ -f "$APP_CONFIG" && ! -L "$APP_CONFIG" ]] || { echo "Missing staging config" >&2; exit 2; }
[[ "$(stat -c %a "$APP_CONFIG")" == 600 && "$(stat -c %u "$APP_CONFIG")" == "$(id -u)" ]] || {
  echo "Invalid staging config permissions" >&2; exit 2;
}
git pull --ff-only --quiet origin main
[[ "$(git rev-parse HEAD)" == "$expected_sha" ]] || {
  echo "Pulled unexpected HEAD; refusing restart" >&2; exit 2;
}
python3.13 -m venv backend/.venv
backend/.venv/bin/python -m pip install --disable-pip-version-check -q -r backend/requirements.txt

# Migrations must be reviewed and applied separately; never during git pull.
(
  cd backend
  set -a
  # shellcheck disable=SC1090
  source "$APP_CONFIG"
  set +a
  [[ "${ENVIRONMENT:-}" == "production" && "${STRIPE_ENABLED:-false}" == false &&
     -z "${STRIPE_SECRET_KEY:-}" && -z "${MERCADO_PAGO_ACCESS_TOKEN:-}" &&
     "${WITHDRAWALS_EXECUTION_ENABLED:-false}" == false ]] || exit 78
  .venv/bin/alembic current --check-heads >/dev/null
) || { echo "MIGRATION_GATE_BLOCKED: DB head differs; manual review needed" >&2; exit 2; }

pm2 restart deploy/pm2/ecosystem.config.cjs --update-env >/dev/null
for _ in {1..20}; do
  if curl -fsS --max-time 3 http://127.0.0.1:18090/api/v1/ready \
      | python3.13 -c 'import json,sys; assert json.load(sys.stdin).get("ready") is True' 2>/dev/null; then
    pm2 jlist | python3.13 -c 'import json,sys; x={p["name"]:p["pm2_env"]["status"] for p in json.load(sys.stdin)}; assert x.get("talaeats-pm2-api-stage")=="online" and x.get("talaeats-pm2-worker-stage")=="online"' || exit 2
    echo "PM2_STAGE_DEPLOY_PASS sha=$expected_sha"
    exit 0
  fi
  sleep 2
done
echo "PM2_STAGE_HEALTH_FAIL: inspect PM2 logs; rollback is manual" >&2
exit 2
