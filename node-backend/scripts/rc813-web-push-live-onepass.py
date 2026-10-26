#!/usr/bin/env python3
"""Web Push public go-live. One explicit run, fail closed.

Never mixes staging PostgreSQL/Redis with LIVE. Reuses reviewed RC8.13
ONE-LIVE cutover with financial audit and PM2 rollback. A pre-migration
production pg_dump is required. Existing money flags are preserved unchanged.
"""
from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit
from urllib.request import urlopen

CANDIDATE = "10f28bcaf63efd3e0ab9dc0366440219da261916"
OLD = "aea74744ba47db2333bcef052b296a7a7ab63eb9"
APPROVAL = "I_APPROVE_REAL_WEB_PUSH_WITH_LIVE_CUTOVER"
SERVICE = Path("/home/tala-node-stage")
ROOT = SERVICE / "tala-node-releases" / CANDIDATE
WORK = ROOT / "node-backend"
LIVE_ENV = SERVICE / ".config/talaeats-node-live.env"
BACKUPS = SERVICE / "tala-node-backups"
PATH = f"{SERVICE}/.local/node24/bin:{SERVICE}/.local/bin:/usr/bin:/bin"
MIGRATION = "20261026043000_web_push_delivery"
DOMAIN = "https://talaeats.alan-palacios-dev.com"
CHECKS = (
 "STRIPE_FINANCIAL_WRITES_ENABLED", "STRIPE_LIVE_ENABLED",
 "STRIPE_LIVE_RELEASE_APPROVED", "STRIPE_REFUNDS_ENABLED",
 "STRIPE_MANUAL_SETTLEMENT_APPROVED",
)
OFF = (
 "STRIPE_CONNECT_TRANSFERS_ENABLED", "STAGE_STRIPE_TEST_CHECKOUT_ENABLED",
 "STAGE_DRIVER_DELIVERY_ENABLED", "STAGE_DELIVERY_CASH_CHECKOUT_ENABLED",
 "STAGE_DELIVERY_STRIPE_TEST_ENABLED",
)

def fail(code):
 print("LIVE_PUSH_HOLD="+code,flush=True)
 raise SystemExit(1)

def execute(args, *, cwd=None, environment=None, timeout=240, quiet=False):
 p=subprocess.run([str(x) for x in args],cwd=cwd,env=environment,
    capture_output=quiet,text=True,timeout=timeout,check=False)
 if p.returncode:
  print("LIVE_PUSH_FAILED_STEP="+str(args[0]),flush=True)
  fail("PRECONDITION_OR_COMMAND_FAILED")
 return p.stdout if quiet else ""

def owned_file(path):
 try:
  s=path.lstat()
  return stat.S_ISREG(s.st_mode) and s.st_uid==os.geteuid() and stat.S_IMODE(s.st_mode)==0o600
 except OSError:return False

def owned_dir(path):
 try:
  s=path.lstat()
  return stat.S_ISDIR(s.st_mode) and s.st_uid==os.geteuid() and stat.S_IMODE(s.st_mode)==0o700
 except OSError:return False

def env_dict(raw):
 data={}
 for line in raw.splitlines():
  if not line.strip() or line.lstrip().startswith("#"):continue
  if "=" not in line:fail("MALFORMED_PRIVATE_ENV")
  k,v=line.split("=",1)
  k=k.strip()
  if not k.isidentifier() or k in data:fail("DUPLICATE_OR_INVALID_LIVE_KEY")
  data[k]=v.strip().strip('"').strip("'")
 return data

def verify_flags(v):
 try:
  pg,rd=urlsplit(v["DATABASE_URL"]),urlsplit(v["REDIS_URL"])
  if(v.get("NODE_ENV")!="production" or v.get("HOST")!="127.0.0.1" or
    v.get("PORT")!="18190" or v.get("STAGE_PARALLEL_ENABLED","false")!="false" or
    pg.scheme not in ("postgres","postgresql") or not pg.password or
    not pg.hostname or not pg.username or not pg.path.strip("/") or
    (pg.hostname=="127.0.0.1" and pg.port==15435) or
    pg.username=="tala_node_stage" or pg.path=="/tala_node_stage" or
    rd.scheme not in ("redis","rediss") or not rd.hostname or not rd.password or
    (rd.hostname=="127.0.0.1" and rd.port==16379 and rd.path in ("","/0","/1")) or
    any(v.get(k,"false")!="true" for k in CHECKS) or
    any(v.get(k,"false")!="false" for k in OFF) or
    v.get("WEB_PUSH_ENABLED","false")!="false"):
   fail("LIVE_POSTGRES_REDIS_OR_PAYMENT_FLAGS_UNEXPECTED")
  if not re.fullmatch(r"(?:sk|rk)_live_[A-Za-z0-9]+",v.get("STRIPE_SECRET_KEY","")):
   fail("EXISTING_LIVE_STRIPE_CREDENTIALS_REQUIRED")
  if not v.get("STRIPE_PUBLISHABLE_KEY","").startswith("pk_live_"):
   fail("LIVE_PUBLISHABLE_KEY_REQUIRED")
  if any(v.get(k) for k in ("WEB_PUSH_VAPID_PUBLIC_KEY","WEB_PUSH_VAPID_PRIVATE_KEY","WEB_PUSH_SUBJECT")):
   fail("EXISTING_VAPID_KEYS_REVIEW_NO_OVERWRITE")
 except (KeyError,TypeError,ValueError):fail("PRODUCTION_URL_INVALID")

def live_http_ready():
 for base in ("http://127.0.0.1:18190",DOMAIN):
  cmd=["curl","-fsS","--connect-timeout","5","--max-time","15"]
  if base.startswith("http://127.0.0.1:"):
   cmd+=["--noproxy","*"]
  try:
   result=subprocess.run(cmd+[base+"/api/v1/ready"],capture_output=True,
     text=True,timeout=19)
   if result.returncode:fail("LIVE_HTTP_CURL_FAILED")
   data=json.loads(result.stdout)
  except (ValueError,subprocess.TimeoutExpired):
   fail("LIVE_HTTP_RESPONSE_INVALID")
  if not(data.get("ready") is True and
    data.get("environment")=="production" and data.get("financialWrites") is True and
    data.get("onlinePaymentsEnabled") is True and data.get("workerOnline") is True):
   fail("LIVE_STRIPE_READINESS_UNEXPECTED")
 print("LIVE_PUSH_EXISTING_STRIPE_HEALTH=PASS")

def verify_pm2():
 # PM2_HOME is EXPLICITLY the default LIVE PM2, never isolated staging PM2.
 env={"HOME":str(SERVICE),"USER":"tala-node-stage","LOGNAME":"tala-node-stage",
  "PATH":PATH,"PM2_HOME":str(SERVICE/".pm2")}
 out=execute(["pm2","jlist"],cwd=SERVICE,environment=env,timeout=12,quiet=True)
 try: apps=json.loads(out)
 except ValueError:fail("LIVE_PM2_UNREADABLE")
 if not isinstance(apps,list) or len(apps)!=2:fail("LIVE_PM2_NOT_TWO_APPS")
 if sorted(x.get("name","") for x in apps)!=["tala-node-stage-api","tala-node-stage-worker"]:
  fail("LIVE_PM2_WRONG_APPS")
 if any(x.get("pm2_env",{}).get("status")!="online" or
        x.get("pm2_env",{}).get("NODE_ENV")!="production" for x in apps):
  fail("LIVE_PM2_NOT_PRODUCTION")
 appdirs={x.get("pm2_env",{}).get("pm_cwd") for x in apps}
 if len(appdirs)!=1:fail("LIVE_PM2_DIFFERENT_RELEASES")
 current=next(iter(appdirs))
 if (not current or not current.endswith("/node-backend") or
    not current.startswith(str(SERVICE/"tala-node-releases")+"/")):
  fail("UNEXPECTED_LIVE_RELEASE_DIRECTORY")
 git=execute(["git","-C",current,"rev-parse","HEAD"],quiet=True)
 if git.strip()!=OLD:fail("EXISTING_LIVE_SHA_CHANGED_REVIEW")
 print("LIVE_PUSH_EXISTING_PM2_SHA=PASS")

def fetch_candidate():
 base=SERVICE/"tala-node-releases"
 if base.is_symlink():fail("RELEASE_DIR_SYMLINK")
 base.mkdir(mode=0o700,exist_ok=True)
 if ROOT.is_symlink():fail("NEW_RELEASE_IS_SYMLINK")
 if not ROOT.exists():
  tmp=Path(tempfile.mkdtemp(prefix=".incoming-live-push-",dir=base))
  try:
   execute(["git","init","-q",str(tmp)])
   execute(["git","-C",str(tmp),"remote","add","origin",
    "https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend.git"])
   execute(["git","-C",str(tmp),"fetch","--depth","1","origin",CANDIDATE])
   execute(["git","-C",str(tmp),"checkout","-q","--detach","FETCH_HEAD"])
   execute(["mv","-T",str(tmp),str(ROOT)])
  finally:
   if tmp.exists():
    import shutil
    shutil.rmtree(tmp)
 if not WORK.is_dir() or WORK.is_symlink():fail("PINNED_WORK_DIRECTORY")
 if execute(["git","-C",str(ROOT),"rev-parse","HEAD"],quiet=True).strip()!=CANDIDATE:
  fail("PINNED_SOURCE_MISMATCH")
 if execute(["git","-C",str(ROOT),"status","--porcelain","--untracked-files=no"],quiet=True).strip():
  fail("MODIFIED_PINNED_SOURCE")
 print("LIVE_PUSH_PINNED_RELEASE=PASS")

def node_script(text):
 env={"HOME":str(SERVICE),"USER":"tala-node-stage","LOGNAME":"tala-node-stage","PATH":PATH}
 return execute([str(SERVICE/".local/node24/bin/node"),"--env-file="+str(LIVE_ENV),
   "--input-type=module","-e",text],cwd=WORK,environment=env,timeout=90,quiet=True)

def exact_migration_check():
 js="""import pg from 'pg';import{readdirSync,statSync}from'node:fs';
const u=new URL(process.env.DATABASE_URL);
if(process.env.NODE_ENV!=='production'||u.pathname==='/tala_node_stage'||u.port==='15435')
 throw Error('NOT_LIVE_DB');
const c=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000});
await c.connect();
try{
 const z=(await c.query("select current_database() db, current_user usr, pg_is_in_recovery() recovery")).rows[0];
 if(z.recovery||z.db==='tala_node_stage'||z.usr==='tala_node_stage')throw Error('LIVE_IDENTITY_HOLD');
 const active=(await c.query('select migration_name, finished_at, rolled_back_at from "_prisma_migrations"')).rows;
 if(active.some(x=>!x.finished_at&&!x.rolled_back_at))throw Error('FAILED_MIGRATIONS');
 const applied=new Set(active.filter(x=>x.finished_at&&!x.rolled_back_at).map(x=>x.migration_name));
 const dirs=readdirSync('prisma/migrations').filter(x=>statSync('prisma/migrations/'+x).isDirectory());
 const missing=dirs.filter(x=>!applied.has(x));
 if(missing.length!==1||missing[0]!=='20261026043000_web_push_delivery'||
    [...applied].some(x=>!dirs.includes(x)))throw Error('MIGRATION_NOT_EXACTLY_PUSH');
 if((await c.query("select to_regclass('public.web_push_deliveries') as tbl")).rows[0].tbl!==null)
  throw Error('LEDGER_TABLE_ALREADY_EXISTS');
 console.log('LIVE_PUSH_EXACTLY_ONE_MIGRATION=PASS');
}finally{await c.end()}"""
 output=node_script(js)
 if "LIVE_PUSH_EXACTLY_ONE_MIGRATION=PASS" not in output:
  fail("PRODUCTION_MIGRATION_STATE_UNEXPECTED")
 print(output.strip())

def before_migration_backup():
 BACKUPS.mkdir(mode=0o700,exist_ok=True)
 if not owned_dir(BACKUPS):fail("LIVE_BACKUP_DIR_NOT_PRIVATE")
 name="live_pre_push_"+dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")+"_"+str(os.getpid())+".dump"
 dest=BACKUPS/name
 # Validate PG connection string and generate a full live backup.
 js="""import{spawnSync}from'node:child_process';import{statSync,chmodSync}from'node:fs';
const u=new URL(process.env.DATABASE_URL),file=process.argv[1];
if(process.env.NODE_ENV!=='production'||u.username==='tala_node_stage'||u.pathname==='/tala_node_stage')
 throw Error('LIVE_DB_GUARD');
const env={...process.env,PGPASSWORD:decodeURIComponent(u.password)};
const result=spawnSync('pg_dump',['-h',u.hostname,'-p',u.port||'5432',
 '-U',decodeURIComponent(u.username),'-d',decodeURIComponent(u.pathname.slice(1)),
 '-Fc','--no-owner','--no-privileges','-f',file],{env,timeout:180000,stdio:'ignore'});
if(result.status!==0||statSync(file).size<4096)throw Error('LIVE_BACKUP_FAILED');
chmodSync(file,0o600);
const listing=spawnSync('pg_restore',['--list',file],{timeout:60000,stdio:'ignore'});
if(listing.status!==0)throw Error('LIVE_BACKUP_ARCHIVE_INVALID');
console.log('LIVE_PUSH_FULL_PRODUCTION_BACKUP=PASS');"""
 env={"HOME":str(SERVICE),"USER":"tala-node-stage","LOGNAME":"tala-node-stage","PATH":PATH}
 command=[str(SERVICE/".local/node24/bin/node"),"--env-file="+str(LIVE_ENV),
  "--input-type=module","-e",js,str(dest)]
 execute(command,cwd=WORK,environment=env,timeout=250)
 if not owned_file(dest):fail("UNVERIFIED_BACKUP_PERMISSIONS")
 print("LIVE_PUSH_BACKUP_FILE="+str(dest))
 print("LIVE_PUSH_PRODUCTION_BACKUP_VERIFIED=PASS")

def set_vapid(original, original_values):
 js="""import webpush from'web-push';process.stdout.write(JSON.stringify(webpush.generateVAPIDKeys()))"""
 data=json.loads(node_script(js))
 pub,priv=data["publicKey"],data["privateKey"]
 if not(re.fullmatch(r"[A-Za-z0-9_-]{86,88}",pub) and re.fullmatch(r"[A-Za-z0-9_-]{42,44}",priv)):
  fail("GENERATED_VAPID_INVALID")
 backup=BACKUPS/("live_env_pre_push_"+dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
   +"_"+str(os.getpid())+".env")
 fd=os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,"w") as f:
  f.write(original);f.flush();os.fsync(f.fileno())
 out="\n".join(line for line in original.splitlines()
  if not re.match(r"\s*WEB_PUSH_(?:ENABLED|VAPID_PUBLIC_KEY|VAPID_PRIVATE_KEY|SUBJECT)\s*=",line))
 out+="\nWEB_PUSH_ENABLED=true\nWEB_PUSH_VAPID_PUBLIC_KEY="+pub+"\nWEB_PUSH_VAPID_PRIVATE_KEY="+priv+"\nWEB_PUSH_SUBJECT=mailto:talaeats6@gmail.com\n"
 parsed=env_dict(out)
 # Preserve every other environment value EXACTLY.
 for k,v in original_values.items():
  if not k.startswith("WEB_PUSH_") and parsed.get(k)!=v:
   fail("PRODUCTION_ENV_WOULD_CHANGE_UNRELATED_VALUE")
 if not owned_file(LIVE_ENV):fail("LIVE_ENV_CHANGED")
 fd,tmp=tempfile.mkstemp(prefix=".live-push-",dir=LIVE_ENV.parent)
 try:
  os.fchmod(fd,0o600)
  with os.fdopen(fd,"w") as f:
   f.write(out);f.flush();os.fsync(f.fileno())
  os.replace(tmp,LIVE_ENV)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)
 print("LIVE_PUSH_PRIVATE_VAPID_GENERATED=PASS")
 return backup

def restore_env(original):
 fd,tmp=tempfile.mkstemp(prefix=".live-push-rollback-",dir=LIVE_ENV.parent)
 try:
  os.fchmod(fd,0o600)
  with os.fdopen(fd,"w") as f:
   f.write(original);f.flush();os.fsync(f.fileno())
  os.replace(tmp,LIVE_ENV)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)
 print("LIVE_PUSH_ENV_RESTORED_AFTER_FAILED_CUTOVER=PASS")

def main():
 if sys.argv[1:]!=["--activate",APPROVAL]:
  fail("EXPLICIT_REAL_LIVE_APPROVAL_REQUIRED")
 if (os.geteuid()==0 or pwd.getpwuid(os.geteuid()).pw_name!="tala-node-stage" or
    os.environ.get("HOME")!=str(SERVICE)):
  fail("SERVICE_USER_ONLY")
 if not owned_file(LIVE_ENV):fail("PRIVATE_LIVE_ENV_NOT_0600")
 oldenv=LIVE_ENV.read_text(encoding="utf8")
 v=env_dict(oldenv);verify_flags(v)
 live_http_ready()
 verify_pm2()
 fetch_candidate()
 print("LIVE_PUSH_CANDIDATE_COMPILING_AND_TESTING=START")
 execute(["bash","scripts/rc813-unified-live-preflight.sh","--prepare",CANDIDATE],cwd=WORK,timeout=250)
 print("LIVE_PUSH_CANDIDATE_COMPILE_TESTS=PASS")
 # Signed Stripe audit before any schema write.
 nodeenv={"HOME":str(SERVICE),"USER":"tala-node-stage","LOGNAME":"tala-node-stage","PATH":PATH}
 execute([str(SERVICE/".local/node24/bin/node"),"--env-file="+str(LIVE_ENV),
  "scripts/rc86-live-activation-audit.mjs"],cwd=WORK,environment=nodeenv,timeout=90)
 print("LIVE_PUSH_FINANCE_READONLY_AUDIT=PASS")
 exact_migration_check()
 before_migration_backup()
 print("LIVE_PUSH_ONLY_ADDITIVE_MIGRATION=START")
 execute([str(SERVICE/".local/node24/bin/node"),"--env-file="+str(LIVE_ENV),
  "./node_modules/prisma/build/index.js","migrate","deploy"],cwd=WORK,environment=nodeenv,timeout=90)
 print("LIVE_PUSH_ONLY_ADDITIVE_MIGRATION=APPLIED")
 execute(["bash","scripts/rc813-unified-live-preflight.sh","--plan",CANDIDATE],cwd=WORK,timeout=100)
 print("LIVE_PUSH_PRECUTOVER_FINANCIAL_PLAN=PASS")
 changed=False
 try:
  set_vapid(oldenv,v)
  changed=True
  execute(["bash","scripts/rc813-unified-live-preflight.sh","--plan",CANDIDATE],cwd=WORK,timeout=100)
  # Existing RC8.13 PM2 cutover rechecks finance, takes a second backup,
  # starts finance worker first, and rolls back on verification failure.
  execute(["bash","scripts/rc813-unified-live-cutover.sh",
   CANDIDATE,"I_APPROVE_RC813_EXISTING_LIVE_PM2_CUTOVER"],cwd=WORK,timeout=220)
  changed=False
 except BaseException:
  if changed:
   restore_env(oldenv)
  print("LIVE_PUSH_PRODUCTION_REVIEW_REQUIRED=YES")
  raise
 execute(["bash","scripts/rc813-unified-live-preflight.sh","--verify",CANDIDATE],cwd=WORK,timeout=60)
 live_http_ready()
 result=subprocess.run(["curl","-fsS","--max-time","15",
  DOMAIN+"/api/v1/v11/push/config"],capture_output=True,text=True,timeout=19)
 if result.returncode:fail("LIVE_WEB_PUSH_CONFIG_HTTP_FAILED")
 try:p=json.loads(result.stdout)
 except ValueError:fail("LIVE_WEB_PUSH_CONFIG_INVALID_JSON")
 if p.get("enabled") is not True or not isinstance(p.get("public_key"),str):
  fail("WEB_PUSH_PUBLIC_NOT_READY_POST_CUTOVER")
 print("LIVE_PUSH_PUBLIC_WEB_CONFIG=PASS")
 print("LIVE_PUSH_STRIPE_PAYMENTS_STILL_ON=PASS")
 print("LIVE_PUSH_BACKEND_ACTIVATION=PASS")
 print("LIVE_PUSH_NEXT=DEPLOY_PUBLIC_PWA_SERVICE_WORKER_WITH_REAL_PUSH_SUBSCRIPTION")

if __name__=="__main__":
 main()
