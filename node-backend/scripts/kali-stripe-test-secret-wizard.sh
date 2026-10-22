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
# Only stdin carries values. Do not use a here-document: it would consume stdin.
printf '%s\n' "$STRIPE_TEST_KEY" "$STRIPE_PUB_KEY" "$STRIPE_WEBHOOK_KEY" |
python3 -c '
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

p=Path(sys.argv[1])
keys=[line.rstrip("\n") for line in sys.stdin]
if len(keys)!=3 or not (
    re.fullmatch(r"sk_test_[A-Za-z0-9]{16,}",keys[0]) and
    re.fullmatch(r"pk_test_[A-Za-z0-9]{16,}",keys[1]) and
    re.fullmatch(r"whsec_[A-Za-z0-9]{16,}",keys[2])
):
    raise SystemExit("ABORT_BAD_TEST_KEYS")

updates={
    "STRIPE_SECRET_KEY":keys[0],
    "STRIPE_PUBLISHABLE_KEY":keys[1],
    "STRIPE_WEBHOOK_SECRET":keys[2],
    "STRIPE_FINANCIAL_WRITES_ENABLED":"false",
    "STAGE_STRIPE_TEST_CHECKOUT_ENABLED":"false",
}
if p.is_symlink() or not p.is_file() or (p.stat().st_mode & 0o777)!=0o600:
    raise SystemExit("ABORT_PRIVATE_ENV_CHANGED")
old=p.read_text()
lines=[]
for line in old.splitlines():
    if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*=",line):
        lines.append(line)
        continue
    name=line.split("=",1)[0]
    if name not in updates:
        lines.append(line)
lines.extend(name+"="+value for name,value in updates.items())
new="\n".join(lines)+"\n"
backup=p.with_name(p.name+".pre-stripe-test-"+datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
fd,tmp=tempfile.mkstemp(prefix=".talaeats-stage-env-",dir=p.parent)
try:
    os.fchmod(fd,0o600)
    with os.fdopen(fd,"w") as out: out.write(new)
    shutil.copyfile(p,backup)
    os.chmod(backup,0o600)
    os.replace(tmp,p)
except BaseException:
    try: os.unlink(tmp)
    except FileNotFoundError: pass
    raise
print("STAGING_STRIPE_TEST_SECRETS_STORED=PASS")
print("STRIPE_LIVE_FINANCIAL_WRITES=DISABLED")
print("STRIPE_TEST_CHECKOUT_STILL_DISABLED=YES")
print("PM2_NOT_RESTARTED=YES")
' "$FILE"
