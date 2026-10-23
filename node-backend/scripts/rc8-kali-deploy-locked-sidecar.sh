#!/usr/bin/env bash
# RC8 isolated QA process in Docker. Financial operations are ALWAYS OFF.
# Does not deploy/modify LIVE checkout, RC7 PM2, Cloudflared, Postgres or Redis.
set -Eeuo pipefail
set +x
umask 077
MODE="${1:-}"
case "$MODE" in --plan|--verify)
  [[ $# -eq 1 ]] || exit 2;;
 --apply)
  [[ $# -eq 2 && "$2" == "I_APPROVE_RC8_LOCKED_SIDECAR_ONLY" ]] || {
    echo "RC8_LOCKED_DEPLOY_APPROVAL_REQUIRED"; exit 2;
  };;
 *)
  echo "USAGE: $0 --plan|--verify|--apply I_APPROVE_RC8_LOCKED_SIDECAR_ONLY"
  exit 2;;
esac
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
NODE="$(cd -- "$HERE/.." && pwd -P)"
REPO="$(cd -- "$NODE/.." && pwd -P)"
SHA="$(basename "$REPO")"
[[ "$SHA" =~ ^[a-f0-9]{40}$ &&
   "$REPO" == "/home/tala-node-stage/tala-node-releases/$SHA" ]] || {
 echo "RC8_LOCKED_DEPLOY_SOURCE_PATH_UNEXPECTED"; exit 1;
}
[[ "$(git -c safe.directory="$REPO" -C "$REPO" rev-parse HEAD)" == "$SHA" ]] || {
 echo "RC8_LOCKED_DEPLOY_GIT_SHA_MISMATCH"; exit 1;
}
COMPOSE="$NODE/deploy/rc8-kali-locked/compose.yaml"
[[ -f "$COMPOSE" ]] || { echo "RC8_LOCKED_DEPLOY_COMPOSE_MISSING"; exit 1; }
command -v docker >/dev/null || { echo "DOCKER_REQUIRED"; exit 1; }
command -v curl >/dev/null || { echo "CURL_REQUIRED"; exit 1; }
docker compose version >/dev/null || { echo "DOCKER_COMPOSE_PLUGIN_REQUIRED"; exit 1; }
PROJECT="tala-node-rc8-locked"
docker compose --project-name "$PROJECT" -f "$COMPOSE" config --quiet

if [[ "$MODE" == --plan ]]; then
  echo "RC8_REVIEWED_SHA=$SHA"
  echo "RC8_HOST_ENDPOINT=http://127.0.0.1:18290"
  echo "RC8_CHECKOUT=DISABLED"
  echo "RC8_STRIPE_LIVE=DISABLED"
  echo "RC7_PM2_AND_CLOUDFLARED=NOT_TOUCHED"
  echo "RC8_LOCKED_DEPLOY_PLAN=PASS"
  exit 0
fi

verify(){
  RC8_HEALTH="$(curl -fsS --max-time 4 http://127.0.0.1:18290/api/v1/health)"
  printf '%s' "$RC8_HEALTH" | grep -Fq '"productionReady":false'
  printf '%s' "$RC8_HEALTH" | grep -Fq '"checkoutEnabled":false'
  printf '%s' "$RC8_HEALTH" | grep -Fq '"transfersEnabled":false'
  RC8_READY="$(curl -sS --max-time 4 -o /dev/null -w '%{http_code}'      http://127.0.0.1:18290/api/v1/ready)"
  [[ "$RC8_READY" == 503 ]] || { echo "RC8_ISOLATION_READY_MUST_BE_503"; return 1; }
  RC7_READY="$(curl -fsS --max-time 4 http://127.0.0.1:18190/api/v1/ready)"
  printf '%s' "$RC7_READY" | grep -Fq '"environment":"staging"'
  printf '%s' "$RC7_READY" | grep -Fq '"financialWrites":false'
  echo "RC8_LOCKED_HEALTH=PASS"
  echo "RC8_READY_503=PASS"
  echo "RC7_PUBLIC_STAGE_UNCHANGED=PASS"
  echo "NO_STRIPE_LIVE_CHARGES=YES"
}
if [[ "$MODE" == --verify ]]; then
  verify
  exit
fi

# Only this named Compose project is changed. Fail closed if a different
# application already occupies RC8's host port.
if ss -H -ltn '( sport = :18290 )' | grep -q .; then
  echo "RC8_LOCKED_DEPLOY_ABORT_PORT_18290_OCCUPIED"
  exit 1
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo "RC8_LOCKED_DEPLOY_REQUIRES_SUDO_FOR_DOCKER"
  exit 1
fi
[[ "$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}'     http://127.0.0.1:18190/api/v1/ready)" == 200 ]] || {
  echo "RC8_LOCKED_DEPLOY_ABORT_RC7_UNHEALTHY"
  exit 1
}
echo "RC8_LOCKED_SIDECAR_START_SHA=$SHA"
docker compose --project-name "$PROJECT" -f "$COMPOSE"   up --detach --build --no-deps rc8-locked
PASS=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if verify >/dev/null 2>&1; then PASS=1; break; fi
  sleep 2
done
if [[ "$PASS" != 1 ]]; then
  # Stop only this new sidecar: NEVER touch public RC7 or other projects.
  docker compose --project-name "$PROJECT" -f "$COMPOSE" stop rc8-locked || true
  echo "RC8_LOCKED_DEPLOY_ROLLBACK_STOPPED_OWN_SIDECAR=YES"
  exit 1
fi
verify
echo "RC8_LOCKED_SIDECAR_DEPLOY=PASS"
echo "RC8_REAL_PAYMENTS_ACTIVATED=NO"
