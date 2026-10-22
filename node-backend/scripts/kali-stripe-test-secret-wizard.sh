#!/usr/bin/env bash
# Run only on Kali as tala-node-stage, AFTER successful RC7 stage gates.
# Interactive Stripe TEST keys: NEVER prints, logs or uploads supplied values.
set +x
set -Eeuo pipefail
umask 077

if [[ ${1:-} != "--plan" && ${1:-} != "--apply" ]] || (( $# != 1 )); then
  echo "USAGE: bash kali-stripe-test-secret-wizard.sh --plan|--apply"
  exit 2
fi
if [[ "$(id -un)" != "tala-node-stage" ||
      "$HOME" != "/home/tala-node-stage" ]]; then
  echo "ABORT: usuario tala-node-stage obligatorio"
  exit 1
fi
FILE="$HOME/.config/talaeats-node-staging.env"
if [[ ! -f "$FILE" || -L "$FILE" ||
      "$(stat -c '%a' "$FILE")" != "600" ||
      "$(stat -c '%u' "$FILE")" != "$(id -u)" ]]; then
  echo "ABORT: archivo .env de staging no existe o no es privado"
  exit 1
fi
if [[ ${1} == "--plan" ]]; then
  echo "STRIPE_TEST_WIZARD_PRECHECK=PASS"
  echo "Aplica solo llaves sk_test_, pk_test_ y whsec_. Nunca LIVE."
  echo "Con --apply se solicitarán las claves sin mostrarlas."
  echo "No habilita checkout, no reinicia PM2, no despliega, no cobra."
  exit 0
fi

read -r -s -p "Stripe secret TEST (sk_test_...): " STRIPE_TEST_KEY; echo
read -r -s -p "Stripe publicable TEST (pk_test_...): " STRIPE_PUB_KEY; echo
read -r -s -p "Firma del endpoint webhook TEST (whsec_...): " STRIPE_WEBHOOK_KEY; echo
trap 'unset STRIPE_TEST_KEY STRIPE_PUB_KEY STRIPE_WEBHOOK_KEY' EXIT

if [[ ! "$STRIPE_TEST_KEY" =~ ^sk_test_[A-Za-z0-9]{16,}$ ||
      ! "$STRIPE_PUB_KEY" =~ ^pk_test_[A-Za-z0-9]{16,}$ ||
      ! "$STRIPE_WEBHOOK_KEY" =~ ^whsec_[A-Za-z0-9]{16,}$ ]]; then
  echo "ABORT: formato TEST inválido; no se modificó el .env"
  exit 1
fi
# Send keys via stdin only. Never command args, stderr, stdout or files in Git.
printf '%s\n' "$STRIPE_TEST_KEY" "$STRIPE_PUB_KEY" "$STRIPE_WEBHOOK_KEY" |
python3 - "$FILE" <<'PY'
# Placeholder — script intentionally requires a reviewed private deployment
# before enabling secret writes. Bash here-doc takes precedence over piped stdin.
raise SystemExit("SECRET_WIZARD_NEEDS_PRIVATE_REVIEW")
PY
