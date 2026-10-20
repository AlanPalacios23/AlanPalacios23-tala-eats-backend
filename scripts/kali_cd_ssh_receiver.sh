#!/usr/bin/env bash
# Root-owned forced-command receiver for an SSH deploy-only public key.
# Install to /usr/local/sbin/talaeats-cd-receiver with mode 0755.
# Engine also root-owned at /usr/local/libexec/talaeats-cd-deploy.py.
set -euo pipefail
umask 077
engine=/usr/local/libexec/talaeats-cd-deploy.py
request="${SSH_ORIGINAL_COMMAND:-}"
case "$request" in
  "talaeats-cd probe")
    exec /usr/bin/python3 "$engine" --self-test
    ;;
  "talaeats-cd preflight "*)
    sha="${request#talaeats-cd preflight }"
    [[ "$sha" =~ ^[0123456789abcdef]{40}$ ]] || { echo "TALA_CD_SSH_INVALID_SHA"; exit 2; }
    exec /usr/bin/python3 "$engine" --check "$sha"
    ;;
  "talaeats-cd deploy "*)
    sha="${request#talaeats-cd deploy }"
    [[ "$sha" =~ ^[0123456789abcdef]{40}$ ]] || { echo "TALA_CD_SSH_INVALID_SHA"; exit 2; }
    exec /usr/bin/python3 "$engine" --deploy "$sha"
    ;;
  *)
    echo "TALA_CD_SSH_COMMAND_DENIED"
    exit 2
    ;;
esac
