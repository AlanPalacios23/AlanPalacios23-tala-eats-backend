#!/usr/bin/env bash
# Install as root-owned /usr/local/sbin/talaeats-green-cd-receiver.
# SSH authorized_keys: restrict,command="/usr/local/sbin/talaeats-green-cd-receiver"
set -euo pipefail
engine=/usr/local/libexec/talaeats-green-cd.py
request="${SSH_ORIGINAL_COMMAND:-}"
case "$request" in
  "talaeats-green-cd probe")
    exec /usr/bin/python3 "$engine" --probe
    ;;
  "talaeats-green-cd preflight "*)
    sha="${request#talaeats-green-cd preflight }"
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo GREEN_CD_INVALID_SHA; exit 2; }
    exec /usr/bin/python3 "$engine" --preflight "$sha"
    ;;
  "talaeats-green-cd deploy "*)
    sha="${request#talaeats-green-cd deploy }"
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo GREEN_CD_INVALID_SHA; exit 2; }
    exec /usr/bin/python3 "$engine" --deploy "$sha"
    ;;
  *)
    echo GREEN_CD_SSH_DENIED
    exit 2
    ;;
esac
