#!/usr/bin/env bash
# TALA EATS: create only one unprivileged staging Linux user.
# --plan read-only; --apply explicitly approved, root only.
# No apt, Docker, PG18, Stripe or live changes.
set -euo pipefail
umask 077
MODE='--plan'
if [ "$#" -gt 0 ]; then MODE="$1"; fi
if [ "$MODE" != '--plan' ] && [ "$MODE" != '--apply' ]; then
  echo 'USAGE --plan|--apply'; exit 2
fi
USER_NAME='tala-node-stage'
HOME_DIR='/home/tala-node-stage'
echo 'TALA_STAGE_USER_SETUP_BEGIN'
if getent passwd "$USER_NAME" >/dev/null 2>&1; then
  echo 'STAGE_ACCOUNT=already_exists'
  if [ "$MODE" = '--apply' ]; then
    echo 'ABORT_STAGE_ACCOUNT_ALREADY_EXISTS'; exit 1
  fi
else
  echo 'STAGE_ACCOUNT=not_created'
fi
if [ -e "$HOME_DIR" ] || [ -L "$HOME_DIR" ]; then
  echo 'STAGE_HOME=already_exists'
  if [ "$MODE" = '--apply' ]; then
    echo 'ABORT_STAGE_HOME_ALREADY_EXISTS'; exit 1
  fi
else
  echo 'STAGE_HOME=not_created'
fi
if [ "$MODE" = '--plan' ]; then
  echo 'PLAN_ONLY_NO_CHANGES'
  echo 'TALA_STAGE_USER_SETUP_END'
  exit 0
fi
if [ "$(id -u)" -ne 0 ]; then echo 'ABORT_ROOT_REQUIRED'; exit 1; fi
if [ "$(printenv TALA_STAGE_USER_APPROVAL 2>/dev/null || true)" != 'I_APPROVE_NEW_STAGE_USER_ONLY' ]; then
  echo 'ABORT_EXPLICIT_STAGE_USER_APPROVAL'; exit 1
fi
if ! command -v useradd >/dev/null 2>&1; then
  echo 'ABORT_USERADD_MISSING'; exit 1
fi
useradd --create-home --user-group --home-dir "$HOME_DIR" --shell /bin/bash "$USER_NAME"
chmod 0700 "$HOME_DIR"
install -d -m 0700 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR/.config"
install -d -m 0700 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR/.local"
if id -nG "$USER_NAME" | tr ' ' '\n' | grep -Eq '^(docker|sudo|adm|root)$'; then
  echo 'ABORT_UNEXPECTED_STAGE_USER_PRIVILEGE'; exit 1
fi
echo 'STAGE_USER_CREATED=PASS'
echo 'STAGE_HOME_PRIVATE=PASS'
echo 'NO_PRODUCTION_CHANGES=yes'
echo 'TALA_STAGE_USER_SETUP_END'
