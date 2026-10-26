#!/usr/bin/env python3
"""Activate already installed VAPID keys in RC8.13 private staging PM2 only.

Before activation: both stage processes online, production still paid-ready,
VAPID keys installed, push disabled, and zero existing active subscriptions.
Apply backs up private .env, toggles only WEB_PUSH_ENABLED, restarts ONLY the
isolated PM2 worker and API, and verifies the heartbeat/public key.
On failure attempts rollback of stage .env and stage PM2 (NEVER LIVE).
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
import time
from urllib.parse import urlsplit
from urllib.request import urlopen

SHA="398b531c4778a03975f30470f6979a38b9c8bb62"
HOME=Path("/home/tala-node-stage")
WORK=HOME / "tala-node-releases" / SHA / "node-backend"
ENV=HOME / ".config/talaeats-node-rc813-parallel.env"
PM2HOME=HOME / ".pm2-tala-rc813-parallel"
BACKUPS=HOME / "tala-node-stage-backups"
PM2=HOME / ".local/bin/pm2"
NODE=HOME / ".local/node24/bin/node"
TOKEN="I_APPROVE_RC813_STAGE_WEB_PUSH_ONLY"
NAMES={
 "tala-rc813-parallel-api":str(WORK / "dist/server.js"),
 "tala-rc813-parallel-worker":str(WORK / "dist/worker.js"),
}
OFF=(
 "STRIPE_FINANCIAL_WRITES_ENABLED","STRIPE_LIVE_ENABLED",
 "STRIPE_LIVE_RELEASE_APPROVED","STRIPE_REFUNDS_ENABLED",
 "STRIPE_CONNECT_TRANSFERS_ENABLED","STRIPE_MANUAL_SETTLEMENT_APPROVED",
 "STAGE_STRIPE_TEST_CHECKOUT_ENABLED","STAGE_DELIVERY_STRIPE_TEST_ENABLED",
)


def fail(reason):
 print("RC813_PUSH_STAGE_HOLD="+reason,flush=True)
 raise SystemExit(1)


def regular_private(path,mode=0o600):
 try:
  m=path.lstat()
  return stat.S_ISREG(m.st_mode) and m.st_uid==os.geteuid() and stat.S_IMODE(m.st_mode)==mode
 except OSError:return False


def owned_dir(path):
 try:
  m=path.lstat()
  return stat.S_ISDIR(m.st_mode) and m.st_uid==os.geteuid()
 except OSError:return False


def values(raw):
 x={}
 for line in raw.splitlines():
  if not line.strip() or line.lstrip().startswith("#"):continue
  if "=" not in line:fail("MALFORMED_STAGE_ENV")
  k,v=line.split("=",1)
  k=k.strip()
  if not k.isidentifier() or k in x:fail("BAD_OR_DUPLICATE_STAGE_ENV")
  x[k]=v.strip().strip('"').strip("'")
 return x


def verify_env(x):
 try:
  pg,rd=urlsplit(x["DATABASE_URL"]),urlsplit(x["REDIS_URL"])
  if(x.get("NODE_ENV")!="staging" or x.get("HOST")!="127.0.0.1" or
     x.get("PORT")!="18192" or x.get("STAGE_PARALLEL_ENABLED")!="true" or
     pg.scheme not in ("postgres","postgresql") or pg.hostname!="127.0.0.1" or
     pg.port!=15435 or pg.username!="tala_node_stage" or
     pg.path!="/tala_node_stage" or not pg.password or
     rd.scheme not in ("redis","rediss") or rd.hostname!="127.0.0.1" or
     rd.port!=16379 or rd.path!="/1" or not rd.password or
     any(x.get(k,"false")!="false" for k in OFF) or
     x.get("WEB_PUSH_ENABLED","false")!="false"):
   fail("STAGING_IDENTITY_OR_FLAGS")
 except (ValueError,KeyError,TypeError):fail("DATABASE_URL_ISOLATION")
 if x.get("STRIPE_SECRET_KEY") and not x["STRIPE_SECRET_KEY"].startswith(("sk_test_","rk_test_")):
  fail("STAGING_HAS_LIVE_PAYMENT_KEY")
 if x.get("STRIPE_PUBLISHABLE_KEY") and not x["STRIPE_PUBLISHABLE_KEY"].startswith("pk_test_"):
  fail("STAGING_HAS_LIVE_PUBLISHABLE_KEY")
 if not(re.fullmatch(r"[A-Za-z0-9_-]{86,88}",x.get("WEB_PUSH_VAPID_PUBLIC_KEY","")) and
        re.fullmatch(r"[A-Za-z0-9_-]{42,44}",x.get("WEB_PUSH_VAPID_PRIVATE_KEY","")) and
        re.fullmatch(r"mailto:[^\s@]+@[^\s@]+",x.get("WEB_PUSH_SUBJECT",""))):
  fail("VAPID_KEYS_NOT_CONFIGURED")


def http(port,path):
 with urlopen(f"http://127.0.0.1:{port}"+path,timeout=4) as res:
  data=json.loads(res.read(4096))
  if res.status!=200:return {}
  return data


def check_services(v,enabled):
 try:
  live=http(18190,"/api/v1/ready")
  stage=http(18192,"/api/v1/ready")
  push=http(18192,"/api/v1/v11/push/config")
 except Exception:fail("API_NOT_READY_OR_UNREACHABLE")
 if (live.get("environment")!="production" or live.get("financialWrites") is not True or
    live.get("onlinePaymentsEnabled") is not True):
  fail("LIVE_IDENTITY_CHANGED")
 if (stage.get("environment")!="staging" or stage.get("ready") is not True or
     stage.get("workerOnline") is not True or stage.get("financialWrites") is not False or
     stage.get("onlinePaymentsEnabled") is not False):
  fail("STAGE_ISOLATION_CHANGED")
 if push.get("enabled") is not enabled:
  fail("PUSH_HTTP_STATE_UNEXPECTED")
 if enabled and push.get("public_key")!=v["WEB_PUSH_VAPID_PUBLIC_KEY"]:
  fail("PUSH_KEY_NOT_PUBLISHED")
 if not enabled and push.get("public_key") is not None:
  fail("PUSH_PREMATURELY_ADVERTISED")


def pm2_env():
 return {
  "HOME":str(HOME),"USER":"tala-node-stage","LOGNAME":"tala-node-stage",
  "PATH":str(HOME / ".local/node24/bin")+":"+str(HOME / ".local/bin")+":/usr/bin:/bin",
  "PM2_HOME":str(PM2HOME),"TALA_RC813_ENV_FILE":str(ENV),"NODE_ENV":"staging"
 }


def run_pm2(*args):
 return subprocess.run([str(PM2),*args],cwd=WORK,env=pm2_env(),
   capture_output=True,text=True,timeout=25,check=False)


def verify_pm2():
 if not owned_dir(PM2HOME) or not regular_private(PM2HOME/"pm2.pid",0o600) and not (PM2HOME/"pm2.pid").is_file():
  fail("STAGE_PM2_DAEMON_NOT_PRESENT")
 try:
  pid=int((PM2HOME/"pm2.pid").read_text().strip())
  os.kill(pid,0)
 except (OSError,ValueError):fail("STAGE_PM2_DAEMON_NOT_ALIVE")
 result=run_pm2("jlist")
 if result.returncode!=0:fail("STAGE_PM2_JLIST_FAILED")
 try: apps=json.loads(result.stdout)
 except ValueError:fail("STAGE_PM2_JLIST_INVALID")
 if not isinstance(apps,list) or len(apps)!=2:fail("UNEXPECTED_STAGE_PM2_PROCESSES")
 names=set()
 for app in apps:
  name=app.get("name")
  env=app.get("pm2_env") or {}
  if (name not in NAMES or name in names or
      env.get("status")!="online" or env.get("pm_exec_path")!=NAMES[name]):
   fail("STAGE_PM2_PROCESS_IDENTITY_HOLD")
  names.add(name)
 if names!=set(NAMES):fail("STAGE_PM2_PROCESS_SET_HOLD")


def active_stage_subs():
 # Read ONLY isolated staging PostgreSQL. Fail closed if there are any active
 # subscriptions: enabling push could send notices to unintended testers.
 js="""import pg from 'pg';
 const p=process.env;
 const c=new pg.Client({connectionString:p.DATABASE_URL,connectionTimeoutMillis:3000});
 await c.connect();
 try{
 const x=await c.query("SELECT count(*)::int AS n FROM push_subscriptions WHERE active=true AND platform='web'");
 process.stdout.write(String(x.rows[0].n));
 }finally{await c.end()}"""
 r=subprocess.run([str(NODE),"--env-file="+str(ENV),"--input-type=module","-e",js],
   cwd=WORK,env={"HOME":str(HOME),"PATH":pm2_env()["PATH"],"NODE_ENV":"staging"},
   capture_output=True,text=True,timeout=8,check=False)
 if r.returncode!=0 or not re.fullmatch(r"\d+",r.stdout.strip()):
  fail("ACTIVE_STAGE_SUBSCRIPTIONS_UNKNOWN")
 if int(r.stdout.strip())!=0:fail("ACTIVE_STAGE_SUBSCRIPTIONS_REQUIRE_REVIEW")
 print("RC813_STAGE_EXISTING_WEB_SUBSCRIPTIONS=ZERO")


def update_env(raw):
 new=re.sub(r"^\s*WEB_PUSH_ENABLED\s*=\s*false\s*$",
  "WEB_PUSH_ENABLED=true",raw,flags=re.M)
 if new==raw:
  new=raw.rstrip()+"\nWEB_PUSH_ENABLED=true\n"
 if new.count("WEB_PUSH_ENABLED=true")!=1:fail("VAPID_ENABLE_FLAG_AMBIGUOUS")
 fd,tmp=tempfile.mkstemp(prefix=".stage-web-push-",dir=ENV.parent)
 try:
  os.fchmod(fd,0o600)
  with os.fdopen(fd,"w",encoding="utf8") as f:
   f.write(new)
   f.flush()
   os.fsync(f.fileno())
  if not regular_private(ENV):fail("STAGE_ENV_CHANGED")
  os.replace(tmp,ENV)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)


def restart_stage_processes():
 for name in ("tala-rc813-parallel-worker","tala-rc813-parallel-api"):
  result=run_pm2("restart",name,"--update-env")
  if result.returncode!=0:raise RuntimeError("ISOLATED_PM2_RESTART_FAILED")


def main():
 args=sys.argv[1:]
 if args!=["--plan"] and args!=["--activate",TOKEN]:
  fail("EXPLICIT_MODE_OR_APPROVAL_REQUIRED")
 if os.geteuid()==0 or pwd.getpwuid(os.geteuid()).pw_name!="tala-node-stage":
  fail("RUN_AS_TALA_NODE_STAGE")
 if not regular_private(ENV):fail("PRIVATE_STAGE_ENV_REQUIRED")
 if not (WORK/"dist/worker.js").is_file() or not (WORK/"dist/server.js").is_file():
  fail("PINNED_RELEASE_NOT_BUILT")
 if not owned_dir(BACKUPS) or stat.S_IMODE(BACKUPS.stat().st_mode)!=0o700:
  fail("PRIVATE_STAGE_BACKUP_DIR_INVALID")
 raw=ENV.read_text(encoding="utf8")
 v=values(raw)
 verify_env(v)
 verify_pm2()
 check_services(v,enabled=False)
 active_stage_subs()
 print("RC813_STAGE_PREACTIVATION_CHECKS=PASS")
 if args==["--plan"]:
  print("RC813_STAGE_PUSH_ACTIVATION_PLAN_READ_ONLY=PASS")
  return
 stamp=dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
 backup=BACKUPS/f"rc813-stage-env-pre-activate-{stamp}-{os.getpid()}.env"
 fd=os.open(backup,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,"w",encoding="utf8") as f:
  f.write(raw);f.flush();os.fsync(f.fileno())
 print("RC813_STAGE_PUSH_PRIVATE_ENV_BACKUP=PASS")
 try:
  update_env(raw)
  restart_stage_processes()
  verified=False
  for attempt in range(12):
   try:
    check_services(v,enabled=True)
    verified=True
    break
   except SystemExit:
    time.sleep(2)
  if not verified:raise RuntimeError("PUSH_STAGE_WORKER_NOT_READY")
  verify_pm2()
 except Exception:
  print("RC813_STAGE_PUSH_ACTIVATION_ROLLBACK=START")
  fd,tmp=tempfile.mkstemp(prefix=".stage-push-restore-",dir=ENV.parent)
  with os.fdopen(fd,"w",encoding="utf8") as f:
   os.fchmod(f.fileno(),0o600)
   f.write(raw);f.flush();os.fsync(f.fileno())
  os.replace(tmp,ENV)
  try:restart_stage_processes()
  except Exception:pass
  print("RC813_STAGE_PUSH_ACTIVATION_ROLLBACK=ATTEMPTED")
  fail("ACTIVATION_FAILED_REVIEW_STAGE_PM2")
 print("RC813_STAGE_WEB_PUSH_ENABLED=PASS")
 print("RC813_STAGE_WEB_PUSH_WORKER_HEARTBEAT=PASS")
 print("RC813_LIVE_AND_DEFAULT_PM2_UNTOUCHED=YES")


if __name__=="__main__":
 main()
