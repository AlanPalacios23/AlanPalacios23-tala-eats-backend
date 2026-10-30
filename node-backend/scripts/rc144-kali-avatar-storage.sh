#!/usr/bin/env bash
# RC144: provision ONLY the new persistent courier avatar directory, never LIVE.
# --plan is read-only; --provision needs root and the exact approval token.
set -Eeuo pipefail
set +x
umask 077
MODE="${1:-}" APPROVAL="${2:-}"
ROOT='/srv/talaeats-media'
DIR="$ROOT/driver-avatars"
if [[ "$MODE" == '--plan' && "$#" -eq 1 ]];then
  : # No modifications, not even a chown.
elif [[ "$MODE" == '--provision' && "$#" -eq 2 &&
        "$APPROVAL" == 'I_APPROVE_RC144_AVATAR_STORAGE_ONLY' &&
        "$(id -u)" == 0 ]];then
  :
else
 echo 'RC144_STORAGE=HOLD_ARGUMENTS_OR_APPROVAL';exit 2
fi
for command in id stat install test;do command -v "$command" >/dev/null || exit 2;done
[[ -d /srv && ! -L /srv ]] || { echo 'RC144_STORAGE=HOLD_SRV_UNSAFE';exit 2; }
id tala-node-stage >/dev/null || { echo 'RC144_STORAGE=HOLD_SERVICE_USER';exit 2; }
[[ ! -L "$ROOT" && ! -L "$DIR" ]] || { echo 'RC144_STORAGE=HOLD_SYMLINK';exit 2; }
if [[ -e "$ROOT" ]];then
 [[ -d "$ROOT" && "$(stat -c '%U' "$ROOT")" == root ]] || {
  echo 'RC144_STORAGE=HOLD_PARENT_OWNER_OR_TYPE';exit 2;
 }
fi
if [[ -e "$DIR" ]];then
 [[ -d "$DIR" && "$(stat -c '%U:%G' "$DIR")" == 'tala-node-stage:tala-node-stage' &&
    "$(stat -c '%a' "$DIR")" == 700 ]] || {
  echo 'RC144_STORAGE=HOLD_EXISTING_DIR_UNSAFE';exit 2;
 }
fi
if [[ "$MODE" == --plan ]];then
 echo "RC144_STORAGE_ROOT=$ROOT"
 echo "RC144_STORAGE_DIR=$DIR"
 echo 'RC144_STORAGE_PLAN=PASS_READ_ONLY'
 [[ -d "$DIR" ]] && echo 'RC144_STORAGE_EXISTING=PASS' ||
   echo 'RC144_STORAGE_EXISTING=NOT_YET_PROVISIONED'
 echo 'RC144_BACKEND_PM2_STRIPE_NGINX_PG=UNCHANGED'
 exit 0
fi
# Install only when missing. Never recurse/chown existing data.
if [[ ! -e "$ROOT" ]];then
 install -d -m 0750 -o root -g tala-node-stage "$ROOT"
fi
if [[ ! -e "$DIR" ]];then
 install -d -m 0700 -o tala-node-stage -g tala-node-stage "$DIR"
fi
[[ ! -L "$DIR" && "$(stat -c '%a %U:%G' "$DIR")" == '700 tala-node-stage:tala-node-stage' ]] || {
 echo 'RC144_STORAGE=HOLD_POSTCHECK';exit 2;
}
echo 'RC144_STORAGE_PROVISION=PASS_AVATAR_DIRECTORY_ONLY'
echo 'RC144_STORAGE_BACKUP_AND_RESTORE=STILL_REQUIRED_BEFORE_LIVE'
echo 'RC144_BACKEND_PM2_STRIPE_NGINX_PG=UNCHANGED'
