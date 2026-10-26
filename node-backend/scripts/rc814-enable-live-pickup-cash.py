#!/usr/bin/env python3
"""Opt-in RC8.14 production CASH pickup flag only after approved real merchant.

Only updates STAGE_PICKUP_CASH_CHECKOUT_ENABLED in the private LIVE env.
Never writes PG, changes Stripe keys, alters Cloudflare, creates money or
touches the worker. Service operator must run AFTER backend pickup promotion.
"""
from __future__ import annotations
from pathlib import Path
import datetime as dt
import json
import os
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tempfile

HOME=Path("/home/tala-node-stage")
ENV=HOME/".config/talaeats-node-live.env"
BACKUPS=HOME/"tala-node-backups"
URL="http://127.0.0.1:18190/api/v1"
PUBLIC="https://talaeats.alan-palacios-dev.com/api/v1"
PM2_HOME=HOME/".pm2"
PATH=f"{HOME}/.local/node24/bin:{HOME}/.local/bin:/usr/bin:/bin"
APPROVAL="I_APPROVE_RC814_PRODUCTION_CASH_PICKUP_ONLY"

def hold(reason):
 print("RC814_CASH_HOLD="+reason,flush=True)
 raise SystemExit(1)
def run(argv,*,cwd=None,env=None,timeout=20):
 p=subprocess.run([str(a) for a in argv],cwd=cwd,env=env,capture_output=True,text=True,timeout=timeout)
 if p.returncode:hold("COMMAND_FAILED_"+str(argv[0]).split("/")[-1].replace(".","_"))
 return p.stdout
def private_file(p):
 try:
  st=p.lstat()
  return stat.S_ISREG(st.st_mode) and st.st_uid==os.geteuid() and stat.S_IMODE(st.st_mode)==0o600
 except OSError:return False
def settings(contents):
 v={}
 for line in contents.splitlines():
  if not line.strip() or line.lstrip().startswith("#"):continue
  if "=" not in line:hold("ENV_FORMAT")
  k,val=line.split("=",1)
  k=k.strip()
  if not k.isidentifier() or k in v:hold("ENV_DUPLICATE_KEY")
  v[k]=val.strip().strip("'").strip('"')
 return v
def verify_site():
 for root in (URL,PUBLIC):
  v=json.loads(run(["curl","-fsS","--connect-timeout","5","--max-time","12",root+"/ready"],timeout=18))
  if not(v.get("ready") is True and v.get("workerOnline") is True and
    v.get("environment")=="production" and v.get("financialWrites") is True and
    v.get("onlinePaymentsEnabled") is True):
   hold("STRIPE_PRODUCTION_NOT_READY")
  push=json.loads(run(["curl","-fsS","--max-time","12",root+"/v11/push/config"],timeout=18))
  if push.get("enabled") is not True or not push.get("public_key"):hold("WEB_PUSH_UNAVAILABLE")
 print("RC814_CASH_STRIPE_AND_PUSH_UNTOUCHED=PASS")
def app_environment():
 return {"HOME":str(HOME),"USER":"tala-node-stage","LOGNAME":"tala-node-stage",
  "PATH":PATH,"PM2_HOME":str(PM2_HOME),"NODE_ENV":"production",
  "TALA_LIVE_ENV_FILE":str(ENV)}
def current_release(sha):
 raw=run(["pm2","jlist"],env=app_environment(),timeout=15)
 try:a=json.loads(raw)
 except ValueError:hold("PM2_UNREADABLE")
 if sorted(z.get("name") for z in a)!=["tala-node-stage-api","tala-node-stage-worker"]:
  hold("PM2_IDENTITIES_CHANGED")
 for process in a:
  meta=process.get("pm2_env",{})
  if meta.get("status")!="online" or meta.get("NODE_ENV")!="production":
   hold("PM2_NOT_PRODUCTION")
  directory=meta.get("pm_cwd")
  if directory!=str(HOME/"tala-node-releases"/sha/"node-backend"):
   hold("PM2_NOT_PINNED_SHA")
 print("RC814_CASH_EXACT_LIVE_PM2_RELEASE=PASS")
def preconditions(v):
 if(v.get("NODE_ENV")!="production" or v.get("HOST")!="127.0.0.1" or
    v.get("PORT")!="18190" or
    any(v.get(k)!="true" for k in (
     "STRIPE_LIVE_ENABLED","STRIPE_FINANCIAL_WRITES_ENABLED",
     "STRIPE_LIVE_RELEASE_APPROVED","STRIPE_REFUNDS_ENABLED",
     "STRIPE_MANUAL_SETTLEMENT_APPROVED")) or
    any(v.get(k,"false")!="false" for k in (
     "STAGE_STRIPE_TEST_CHECKOUT_ENABLED","STAGE_DELIVERY_CASH_CHECKOUT_ENABLED",
     "STAGE_DELIVERY_STRIPE_TEST_ENABLED","STRIPE_CONNECT_TRANSFERS_ENABLED"))):
  hold("UNREVIEWED_LIVE_MONEY_FLAGS")
 u=v.get("DATABASE_URL","")
 if not u.startswith("postgresql://") or "tala_node_stage" in u:hold("PRODUCTION_DATABASE_REQUIRED")
def eligible_owner_count():
 # Exact LIVE database identity and a READ ONLY transaction; no customer
 # details or Stripe account IDs leave the host or enter stdout.
 script="""import pg from 'pg';
const u=new URL(process.env.DATABASE_URL);
if(process.env.NODE_ENV!=='production'||u.port!=='15445'||u.pathname!=='/tala_node_live')
 throw Error('NOT_LIVE');
const c=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:4000});
await c.connect();
try{
 await c.query('BEGIN TRANSACTION READ ONLY');
 const r=await c.query(`SELECT count(*)::int AS qty FROM restaurants r
 JOIN users u ON u.id=r.owner_id
 JOIN tala_live_merchant_accounts m ON m.restaurant_id=r.id
 WHERE r.verification_status='verified' AND r.onboarding_status='approved'
 AND r.pickup_enabled=true AND r.is_open=true AND u.is_active=true
 AND m.owner_approved_at IS NOT NULL`);
 await c.query('ROLLBACK');
 console.log(r.rows[0].qty);
}finally{await c.end()}"""
 sha_directory=next(iter([z.get("pm2_env",{}).get("pm_cwd") for z in json.loads(
  run(["pm2","jlist"],env=app_environment(),timeout=15)) if z.get("name")=="tala-node-stage-api"]))
 out=run([str(HOME/".local/node24/bin/node"),"--env-file="+str(ENV),"--input-type=module","-e",script],
  cwd=sha_directory,env={"HOME":str(HOME),"PATH":PATH},timeout=22)
 try:qty=int(out.strip())
 except ValueError:hold("MERCHANT_READONLY_AUDIT_FAILED")
 print("RC814_CASH_ELIGIBLE_REAL_MERCHANT_COUNT="+str(qty))
 return qty
def atomic_write(contents):
 fd,temp=tempfile.mkstemp(prefix=".cash-pickup-",dir=ENV.parent)
 try:
  os.fchmod(fd,0o600)
  with os.fdopen(fd,"w") as file:
   file.write(contents);file.flush();os.fsync(file.fileno())
  os.replace(temp,ENV)
 finally:
  if os.path.exists(temp):os.unlink(temp)
def main():
 if len(sys.argv) not in (3,4) or sys.argv[1] not in ("--plan","--activate") or
  not re.fullmatch(r"[a-f0-9]{40}",sys.argv[2]):
  hold("USE_PLAN_OR_ACTIVATE_WITH_SHA")
 mode,sha=sys.argv[1:3]
 if mode=="--activate" and (len(sys.argv)!=4 or sys.argv[3]!=APPROVAL):
  hold("EXPLICIT_CASH_APPROVAL_REQUIRED")
 if mode=="--plan" and len(sys.argv)!=3:hold("UNEXPECTED_ARGUMENTS")
 if os.geteuid()==0 or pwd.getpwuid(os.geteuid()).pw_name!="tala-node-stage" or
   os.environ.get("HOME")!=str(HOME):
  hold("SERVICE_USER_REQUIRED")
 if not private_file(ENV):hold("LIVE_ENV_PRIVATE_0600")
 old=ENV.read_text()
 v=settings(old);preconditions(v)
 current_release(sha);verify_site()
 qty=eligible_owner_count()
 if v.get("STAGE_PICKUP_CASH_CHECKOUT_ENABLED")=="true":
  print("RC814_LIVE_CASH_PICKUP_ALREADY_ENABLED=PASS")
  return
 if v.get("STAGE_PICKUP_CASH_CHECKOUT_ENABLED","false")!="false":
  hold("CASH_FLAG_UNKNOWN")
 if qty<1:hold("REAL_VERIFIED_APPROVED_OPEN_MERCHANT_REQUIRED")
 if mode=="--plan":
  print("RC814_LIVE_CASH_FLAG_PLAN=PASS_NO_WRITES")
  return
 if not BACKUPS.is_dir() or BACKUPS.is_symlink() or
    BACKUPS.stat().st_uid!=os.geteuid() or stat.S_IMODE(BACKUPS.stat().st_mode)!=0o700:
  hold("PRIVATE_BACKUP_DIR_REQUIRED")
 backup=BACKUPS/("rc814-pre-live-cash-"+dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")+
  "-"+str(os.getpid())+".env")
 handle=os.open(backup,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
 with os.fdopen(handle,"w") as f:
  f.write(old);f.flush();os.fsync(f.fileno())
 print("RC814_CASH_ENV_BACKUP=PASS")
 changed=re.sub(r"(?m)^STAGE_PICKUP_CASH_CHECKOUT_ENABLED=.*$",
   "STAGE_PICKUP_CASH_CHECKOUT_ENABLED=true",old)
 if changed==old:changed=old.rstrip("\n")+"\nSTAGE_PICKUP_CASH_CHECKOUT_ENABLED=true\n"
 for key,value in v.items():
  if key!="STAGE_PICKUP_CASH_CHECKOUT_ENABLED" and settings(changed).get(key)!=value:
   hold("UNRELATED_LIVE_FLAG_CHANGE")
 try:
  atomic_write(changed)
  run(["pm2","restart","tala-node-stage-api","--update-env"],env=app_environment(),timeout=30)
  verify_site()
 except BaseException:
  atomic_write(old)
  try:run(["pm2","restart","tala-node-stage-api","--update-env"],env=app_environment(),timeout=30)
  except Exception:pass
  print("RC814_CASH_ENV_ROLLBACK_ATTEMPTED_OPERATOR_REVIEW_REQUIRED")
  raise
 print("RC814_PICKUP_CASH_LIVE_ENABLED=PASS")
 print("RC814_NO_STRIPE_CHARGE_OR_CONNECT_PAYOUT=YES")
if __name__=="__main__":main()
