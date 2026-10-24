#!/usr/bin/env bash
# Quarantine ONLY the failed RC8.13 isolated PM2 HOME left by a rejected rollout.
# Never stop or alter any daemon, process, Redis key, DB, or LIVE PM2 instance.
set -Eeuo pipefail
set +x
umask 077
MODE="${1:-}"; APPROVE="${2:-}"
if [[ "$#" -lt 1 || "$#" -gt 2 || ! "$MODE" =~ ^--(plan|apply)$ ]]; then
 echo 'USAGE: bash scripts/rc813-quarantine-aborted-pm2.sh --plan | --apply I_APPROVE_QUARANTINE_FAILED_RC813_PM2'
 exit 2
fi
[[ "$(id -un)" == 'tala-node-stage' && "$HOME" == '/home/tala-node-stage' ]] || {
 echo 'RC813_RECOVERY_ABORT=STAGE_USER_ONLY'; exit 1;
}
HOME_DIR="/home/tala-node-stage/.pm2-tala-rc813-parallel"
if [[ ! -e "$HOME_DIR" && ! -L "$HOME_DIR" ]]; then
 echo 'RC813_FAILED_PM2_RESIDUE=ABSENT'; exit 0
fi
[[ -d "$HOME_DIR" && ! -L "$HOME_DIR" &&
   "$(stat -c '%u' "$HOME_DIR")" == "$(id -u)" ]] || {
 echo 'RC813_RECOVERY_ABORT=UNEXPECTED_HOME_OWNER_OR_LINK'; exit 1;
}
if [[ -s "$HOME_DIR/dump.pm2" ]]; then
 echo 'RC813_RECOVERY_ABORT=SAVED_PROCESS_DUMP_PRESENT'; exit 1
fi
if [[ -f "$HOME_DIR/pm2.pid" ]]; then
 pid="$(cat "$HOME_DIR/pm2.pid")"
 if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
   echo 'RC813_RECOVERY_ABORT=INVALID_PID_FILE'; exit 1
 fi
 if kill -0 "$pid" 2>/dev/null; then
   echo 'RC813_RECOVERY_ABORT=DAEMON_PID_STILL_ALIVE'; exit 1
 fi
fi
# Cross-check PM2 God daemon name without spawning a new PM2 daemon.
if ps -u "$(id -un)" -o args= | grep -F 'God Daemon (' | grep -F "$HOME_DIR" >/dev/null 2>&1; then
 echo 'RC813_RECOVERY_ABORT=GOD_DAEMON_STILL_PRESENT'; exit 1
fi
if ss -lntH | awk '{print $4}' | grep -Eq '(^|:)18192$'; then
 echo 'RC813_RECOVERY_ABORT=STAGE_PORT_18192_IN_USE'; exit 1
fi
echo 'RC813_FAILED_PM2_RESIDUE_SAFE_TO_QUARANTINE=PASS'
if [[ "$MODE" == '--plan' ]]; then
 echo 'RC813_QUARANTINE_PLAN_READ_ONLY=PASS'; exit 0
fi
[[ "$#" == 2 && "$APPROVE" == 'I_APPROVE_QUARANTINE_FAILED_RC813_PM2' ]] || {
 echo 'RC813_RECOVERY_ABORT=EXPLICIT_APPROVAL_REQUIRED'; exit 2
}
QUARANTINE="$HOME_DIR.failed-$(date -u +%Y%m%dT%H%M%SZ)-$$"
[[ ! -e "$QUARANTINE" ]] || {
 echo 'RC813_RECOVERY_ABORT=QUARANTINE_ALREADY_EXISTS'; exit 1
}
mv -T -- "$HOME_DIR" "$QUARANTINE"
echo 'RC813_FAILED_PM2_RESIDUE_QUARANTINED=PASS'
echo 'RC813_LIVE_PM2_PROCESSES_CLOUDFLARE_DB_UNTOUCHED=YES'
