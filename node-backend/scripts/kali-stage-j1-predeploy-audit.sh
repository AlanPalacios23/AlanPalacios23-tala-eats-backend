#!/usr/bin/env bash
# Plan/read-only: gathers isolated Node STAGING facts. No deploy, no restart.
set -euo pipefail
if [[ $# -gt 1 ]] || { [[ $# -eq 1 ]] && [[ "$1" != "--plan" ]]; }; then
  echo "STAGE_PREDEPLOY=DENIED_UNKNOWN_MODE"; exit 2
fi
if [[ "$(id -un)" != "tala-node-stage" ]]; then
  echo "STAGE_PREDEPLOY=DENIED_WRONG_UNIX_USER"; exit 3
fi
if [[ "$(pwd -P)" != /home/tala-node-stage/* ]]; then
  echo "STAGE_PREDEPLOY=DENIED_OUTSIDE_STAGE_HOME"; exit 4
fi
if [[ ! -f node-backend/package-lock.json || ! -f node-backend/prisma/schema.prisma ]]; then
  echo "STAGE_PREDEPLOY=DENIED_NOT_NODE_REPO_ROOT"; exit 5
fi
SHA="$(git rev-parse --verify HEAD)"
printf 'STAGE_PLAN_SOURCE_SHA=%s\n' "$SHA"
printf 'STAGE_PLAN_DIR=%s\n' "$(pwd -P)"
echo "STAGE_PLAN_MODE=READ_ONLY_NO_CHANGES"
for port in 15435 16379 18190; do
  if command -v ss >/dev/null 2>&1; then
    if ss -lnt | grep -Eq "127[.]0[.]0[.]1:$port([[:space:]]|$)"; then
      echo "STAGE_LOOPBACK_PORT_$port=LISTENING"
    else
      echo "STAGE_LOOPBACK_PORT_$port=NOT_LISTENING"
    fi
  else
    echo "STAGE_NETWORK_CHECK=SKIPPED_NO_SS"
  fi
done
if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 5 http://127.0.0.1:18190/api/v1/health >/dev/null; then
    echo "STAGE_HEALTH=HTTP_200"
  else
    echo "STAGE_HEALTH=NOT_READY_OR_NOT_RUNNING"
  fi
  if curl -fsS --max-time 5 http://127.0.0.1:18190/api/v1/ready | grep -Eq '"financialWrites"[[:space:]]*:[[:space:]]*false'; then
    echo "STAGE_READY_FINANCIAL_WRITES=FALSE"
  else
    echo "STAGE_READY_FINANCIAL_WRITES=UNKNOWN_ABORT_BEFORE_DEPLOY"
  fi
fi
if command -v systemctl >/dev/null 2>&1; then
  for unit in tala-node-stage-pg15.service tala-node-stage-redis.service tala-node-stage-pm2.service; do
    if systemctl --user is-active --quiet "$unit" 2>/dev/null; then
      printf 'STAGE_SYSTEMD_%s=ACTIVE\n' "$unit"
    else
      printf 'STAGE_SYSTEMD_%s=INACTIVE_OR_INACCESSIBLE\n' "$unit"
    fi
  done
fi
if [[ -d "/home/tala-node-stage/media" ]]; then
  echo "STAGE_MEDIA_DIRECTORY=PRESENT"
  printf 'STAGE_MEDIA_PERMS=%s\n' "$(stat -c '%a %U' /home/tala-node-stage/media)"
else
  echo "STAGE_MEDIA_DIRECTORY=MISSING_DO_NOT_ENABLE_UPLOADS"
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "STAGE_WORKTREE=DIRTY_DO_NOT_REPLACE_CURRENT"
else
  echo "STAGE_WORKTREE=CLEAN"
fi
echo "STAGE_PREDEPLOY_PLAN=COMPLETE_READ_ONLY"
echo "STAGE_DEPLOY_EXECUTED=FALSE"
echo "PYTHON_PRODUCTION_TOUCHED=FALSE"
