#!/usr/bin/env bash
# Tala Eats RC9.4: opt-in LIVE password recovery mail activation.
# Run as tala-node-stage with --status or --activate. No Stripe/DB money writes.
set -Eeuo pipefail
set +x
umask 077
MODE="${1:-}"
SHA="0c8d92fa62ae910843b3d4c764da85a852b17085"
ROOT="/home/tala-node-stage/tala-node-releases/$SHA"
WORK="$ROOT/node-backend"
ENV="/home/tala-node-stage/.config/talaeats-node-live.env"
export PATH="/home/tala-node-stage/.local/node24/bin:/home/tala-node-stage/.local/bin:$PATH"
if [[ "$#" != 1 || ( "$MODE" != "--status" && "$MODE" != "--activate" ) ]]; then
 echo 'USAGE: rc94-kali-activate-resend-mail.sh --status|--activate'; exit 2
fi
if [[ "$(id -un)" != tala-node-stage || "$HOME" != /home/tala-node-stage || "$(id -u)" == 0 ]]; then
 echo 'RC94_MAIL_HOLD=WRONG_USER';exit 1
fi
[[ -f "$ENV" && ! -L "$ENV" && "$(stat -c %a "$ENV")" == 600 &&
 "$(stat -c %u "$ENV")" == "$(id -u)" &&
 -f "$WORK/dist/server.js" && -f "$WORK/dist/live/production-worker.js" &&
 "$(git -C "$ROOT" rev-parse HEAD)" == "$SHA" &&
 -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]] || {
 echo 'RC94_MAIL_HOLD=RELEASE_OR_ENV_NOT_LOCKED';exit 1;
}
cd "$WORK"
export RC94_EXPECTED_DIR="$WORK"
pm2 jlist | node -e '
let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{
 try{
  const a=JSON.parse(s);
  for(const [name,rel] of Object.entries({
    "tala-node-stage-api":"dist/server.js",
    "tala-node-stage-worker":"dist/live/production-worker.js"
  })){
   const p=a.filter(x=>x.name===name);
   if(p.length!==1||p[0].pm2_env?.status!=="online"||
    p[0].pm2_env.pm_cwd!==process.env.RC94_EXPECTED_DIR||
    p[0].pm2_env.pm_exec_path!==process.env.RC94_EXPECTED_DIR+"/"+rel)
    throw Error("WRONG_PM2_RELEASE");
  }
  console.log("RC94_MAIL_LIVE_PM2=PASS");
 }catch{console.log("RC94_MAIL_HOLD=PM2_DIFFERENT_RELEASE");process.exitCode=1;}
});'
node --env-file="$ENV" --input-type=module <<'JS'
import {config} from './dist/config.js';
const pg=new URL(config.DATABASE_URL);
if(config.NODE_ENV!=='production'||pg.hostname!=='127.0.0.1'||
 pg.port!=='15445'||pg.pathname!=='/tala_node_live'||
 config.STRIPE_CONNECT_TRANSFERS_ENABLED!=='false'||
 config.TREASURY_CONNECT_WEBHOOK_INGEST_ENABLED!=='false'||
 config.STRIPE_FINANCIAL_WRITES_ENABLED!=='true'||
 config.STRIPE_LIVE_ENABLED!=='true'||
 config.STRIPE_LIVE_RELEASE_APPROVED!=='true')
 throw Error('RC94_MAIL_HOLD=LIVE_FINANCIAL_FLAGS');
console.log('RC94_MAIL_PAYMENT_GUARDS=PASS');
console.log('RC94_MAIL_DELIVERY_MODE='+config.LIVE_AUTH_EMAIL_DELIVERY_MODE);
JS
if [[ "$MODE" == --status ]]; then
 node --env-file="$ENV" scripts/rc94-live-password-recovery-audit.mjs
 echo 'RC94_MAIL_STATUS=READ_ONLY_PASS'
 exit 0
fi
node --env-file="$ENV" --input-type=module <<'JS'
import {config} from './dist/config.js';
if(config.LIVE_AUTH_EMAIL_DELIVERY_MODE!=='disabled')
 throw Error('RC94_MAIL_HOLD=ALREADY_ENABLED');
JS
[[ -r /dev/tty && -w /dev/tty ]] || {
 echo 'RC94_MAIL_HOLD=RUN_DIRECTLY_IN_INTERACTIVE_TERMINAL';exit 1;
}
printf 'Correo remitente VERIFICADO en Resend: ' >/dev/tty
IFS= read -r FROM </dev/tty
printf 'Tu correo para recibir una prueba: ' >/dev/tty
IFS= read -r TEST_TO </dev/tty
printf 'Resend API Key, permiso Sending (oculta): ' >/dev/tty
IFS= read -rs API_KEY </dev/tty
printf '\n' >/dev/tty
if [[ ! "$FROM" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ||
 ! "$TEST_TO" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ||
 ! "$API_KEY" =~ ^re_[A-Za-z0-9_-]{12,}$ ]]; then
 unset API_KEY;echo 'RC94_MAIL_HOLD=INVALID_INPUT_OR_KEY';exit 1
fi
# A sending-scoped Resend key cannot list domains. Instead authenticate and
# send a single provider test from the exact requested identity, then require
# operator confirmation of receipt BEFORE changing the private LIVE env.
SECRET_DIR="$HOME/.config/talaeats-rc94-mail"
mkdir -p -m 700 "$SECRET_DIR"
[[ ! -L "$SECRET_DIR" && "$(stat -c %a "$SECRET_DIR")" == 700 ]] || {
 echo 'RC94_MAIL_HOLD=SECRET_DIRECTORY_INVALID';exit 1;
}
SECRET=$(mktemp "$SECRET_DIR/resend-test.XXXXXXXX")
chmod 600 "$SECRET"
printf '%s' "$API_KEY" >"$SECRET"
unset API_KEY
trap 'rm -f -- "$SECRET"' EXIT
export RC94_TEST_KEY_FILE="$SECRET" RC94_TEST_FROM="$FROM" RC94_TEST_TO="$TEST_TO"
node --input-type=module <<'JS'
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
const key=readFileSync(process.env.RC94_TEST_KEY_FILE,'utf8');
let r;
try {
 r=await fetch('https://api.resend.com/emails',{
  method:'POST',
  headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',
   'Idempotency-Key':'tala-rc94-verify-'+randomUUID()},
  body:JSON.stringify({
   from:process.env.RC94_TEST_FROM,to:[process.env.RC94_TEST_TO],
   subject:'Tala Eats - prueba de recuperacion de contrasena',
   text:'Prueba de correo. No necesitas responder.'
  }),signal:AbortSignal.timeout(12000)
 });
}catch{throw Error('RC94_MAIL_HOLD=RESEND_UNREACHABLE');}
if(!r.ok)throw Error('RC94_MAIL_HOLD=RESEND_REJECTED_HTTP_'+r.status);
const j=await r.json();
if(typeof j.id!=='string'||!j.id)throw Error('RC94_MAIL_HOLD=RESEND_NO_MESSAGE_ID');
console.log('RC94_RESEND_PROVIDER_ACCEPTED_TEST=PASS');
JS
printf 'Revisa tu buzon. Si recibiste la prueba, escribe RECIBIDO: ' >/dev/tty
IFS= read -r CONFIRM </dev/tty
if [[ "$CONFIRM" != RECIBIDO ]]; then
 echo 'RC94_MAIL_HOLD=INBOX_NOT_CONFIRMED';exit 1
fi
# No existing user recovery email is resent here. The worker will expire
# pending reset links older than 25min rather than sending unusable links.
BACKUP="$ENV.before-rc94-mail-$(date -u +%Y%m%dT%H%M%SZ)-$$"
cp -p -- "$ENV" "$BACKUP"
chmod 600 "$BACKUP"
export RC94_LIVE_ENV="$ENV"
rollback_required=yes
rollback(){
 code=$?
 trap - EXIT
 rm -f -- "$SECRET"
 if [[ "$rollback_required" == yes ]]; then
  cp -p -- "$BACKUP" "$ENV"
  chmod 600 "$ENV"
  for app in tala-node-stage-worker tala-node-stage-api; do
   env -i HOME="$HOME" USER=tala-node-stage LOGNAME=tala-node-stage \
     PATH="$PATH" PM2_HOME="$HOME/.pm2" NODE_ENV=production \
     TALA_LIVE_ENV_FILE="$ENV" pm2 restart "$app" --update-env >/dev/null 2>&1 || true
  done
  echo 'RC94_MAIL_ROLLBACK=OLD_ENV_RESTORED_PM2_RESTART_ATTEMPTED'
 fi
 exit "$code"
}
trap rollback EXIT
node --input-type=module <<'JS'
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
const path=process.env.RC94_LIVE_ENV;
const value={
 LIVE_AUTH_EMAIL_DELIVERY_MODE:'resend',
 LIVE_AUTH_EMAIL_SENDER_APPROVED:'true',
 LIVE_AUTH_EMAIL_RESEND_API_KEY:readFileSync(process.env.RC94_TEST_KEY_FILE,'utf8'),
 LIVE_AUTH_EMAIL_FROM:process.env.RC94_TEST_FROM,
};
let data=readFileSync(path,'utf8');
for(const [k,v] of Object.entries(value)){
 const exp=new RegExp('^\\s*(?:export\\s+)?'+k+'\\s*=.*$','gm');
 const n=[...data.matchAll(exp)].length;
 if(n>1)throw Error('RC94_MAIL_HOLD=DUPLICATE_ENV_'+k);
 if(n===1)data=data.replace(exp,k+'='+v);
 else data+='\n'+k+'='+v+'\n';
}
const tmp=path+'.rc94-new-'+process.pid;
writeFileSync(tmp,data,{mode:0o600,flag:'wx'});
renameSync(tmp,path);
console.log('RC94_PRIVATE_LIVE_ENV=UPDATED');
JS
node --env-file="$ENV" --input-type=module <<'JS'
import {config} from './dist/config.js';
if(config.LIVE_AUTH_EMAIL_DELIVERY_MODE!=='resend'||
 config.LIVE_AUTH_EMAIL_SENDER_APPROVED!=='true'||
 config.STRIPE_CONNECT_TRANSFERS_ENABLED!=='false'||
 config.TREASURY_CONNECT_WEBHOOK_INGEST_ENABLED!=='false'||
 config.STRIPE_FINANCIAL_WRITES_ENABLED!=='true')
 throw Error('RC94_MAIL_HOLD=CONFIG_RECHECK_FAILED');
console.log('RC94_LIVE_AUTH_CONFIG=PASS');
JS
live_pm2(){
 env -i HOME="$HOME" USER=tala-node-stage LOGNAME=tala-node-stage \
 PATH="$PATH" PM2_HOME="$HOME/.pm2" NODE_ENV=production \
 TALA_LIVE_ENV_FILE="$ENV" pm2 "$@"
}
live_pm2 restart tala-node-stage-worker --update-env >/dev/null
live_pm2 restart tala-node-stage-api --update-env >/dev/null
healthy=no
for i in $(seq 1 25); do
 if curl -fsS --max-time 5 http://127.0.0.1:18190/api/v1/ready 2>/dev/null |
 node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{
 try{const d=JSON.parse(s);
 process.exit(d.ready===true&&d.workerOnline===true&&d.environment==="production"&&
 d.onlinePaymentsEnabled===true?0:1)}catch{process.exit(1)}});' >/dev/null 2>&1;then
  healthy=yes;break
 fi
 sleep 2
done
[[ "$healthy" == yes ]] || { echo 'RC94_MAIL_HOLD=LOCAL_READINESS';exit 1; }
curl -fsS --max-time 12 'https://talaeats.alan-palacios-dev.com/api/v1/ready' |
node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{
 try{const d=JSON.parse(s);process.exit(d.ready===true&&d.workerOnline===true&&
 d.onlinePaymentsEnabled===true?0:1)}catch{process.exit(1)}});'
live_pm2 save >/dev/null
rollback_required=no
trap - EXIT
rm -f -- "$SECRET"
node --env-file="$ENV" scripts/rc94-live-password-recovery-audit.mjs
echo 'RC94_MAIL_PUBLIC_HTTPS_READY=PASS'
echo 'RC94_MAIL_PROVIDER_TEST_RECEIVED=OPERATOR_CONFIRMED'
echo 'RC94_MAIL_DELIVERY=ENABLED'
echo 'RC94_MONEY_MOVEMENT=UNCHANGED'
echo 'RC94_CONNECT_WITHDRAWALS=LOCKED'
