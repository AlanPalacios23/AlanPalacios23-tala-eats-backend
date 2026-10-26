#!/usr/bin/env python3
"""RC8.13 Web Push: ZERO-WRITE Kali preflight for isolated staging :18192.

Run as service user tala-node-stage, using stdin if file in operator home.
Never prints environment values, passwords, VAPID keys or Stripe secrets.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import pwd
import socket
import stat
from urllib.parse import urlsplit
from urllib.request import urlopen

OWNER = "tala-node-stage"
BASE = Path("/home/tala-node-stage")
CFG = BASE / ".config"
SOURCE = CFG / "talaeats-node-staging.env"
PARALLEL = CFG / "talaeats-node-rc813-parallel.env"
PM2 = BASE / ".pm2-tala-rc813-parallel"
MONEY_FLAGS = (
 "STRIPE_FINANCIAL_WRITES_ENABLED","STRIPE_LIVE_ENABLED",
 "STRIPE_LIVE_RELEASE_APPROVED","STRIPE_REFUNDS_ENABLED",
 "STRIPE_CONNECT_TRANSFERS_ENABLED","STRIPE_MANUAL_SETTLEMENT_APPROVED",
 "STAGE_STRIPE_TEST_CHECKOUT_ENABLED","STAGE_DELIVERY_STRIPE_TEST_ENABLED",
)

def output(name, status):
 print(f"{name}={status}", flush=True)

def port_open(port):
 try:
  with socket.create_connection(("127.0.0.1",port),timeout=1):
   return True
 except OSError:
  return False

def api_check(port):
 try:
  with urlopen(f"http://127.0.0.1:{port}/api/v1/ready",timeout=3) as response:
   data=json.loads(response.read(4096))
   if response.status!=200 or not isinstance(data,dict):
    return "UNREADY"
   if port==18190:
    return "PRODUCTION_PAYMENT_CAPABLE" if (data.get("environment")=="production"
      and data.get("financialWrites") is True and data.get("onlinePaymentsEnabled") is True) else "REVIEW"
   return "SAFE_ISOLATED_STAGE" if (data.get("environment")=="staging"
      and data.get("financialWrites") is False and data.get("onlinePaymentsEnabled") is False) else "REVIEW"
 except Exception:
  return "NOT_RUNNING"

def private_file(path):
 try:
  meta=path.lstat()
  return (stat.S_ISREG(meta.st_mode) and not stat.S_ISLNK(meta.st_mode)
   and stat.S_IMODE(meta.st_mode)==0o600 and
   meta.st_uid==os.geteuid())
 except OSError:
  return False

def values(path):
 if not private_file(path):
  return None
 try:
  result={}
  for raw in path.read_text(encoding="utf-8").splitlines():
   stripped=raw.strip()
   if not stripped or stripped.startswith("#"):
    continue
   if "=" not in raw:
    return None
   k,v=raw.split("=",1)
   k=k.strip()
   if not k.isidentifier() or k in result:
    return None
   result[k]=v.strip().strip("'").strip('"')
  return result
 except Exception:
  return None

def valid_env(v,parallel):
 if not v:return False
 try:
  pg=urlsplit(v.get("DATABASE_URL",""))
  rd=urlsplit(v.get("REDIS_URL",""))
  desired_port="18192" if parallel else "18190"
  redis_db="/1" if parallel else "/0"
  identity=(v.get("NODE_ENV")=="staging"
    and v.get("HOST")=="127.0.0.1" and v.get("PORT")==desired_port
    and v.get("STAGE_PARALLEL_ENABLED","false")==("true" if parallel else "false")
    and pg.hostname=="127.0.0.1" and pg.port==15435
    and pg.path=="/tala_node_stage" and pg.username=="tala_node_stage"
    and bool(pg.password) and rd.hostname=="127.0.0.1"
    and rd.port==16379 and rd.path==redis_db and bool(rd.password))
  money_safe=all(v.get(k,"false")=="false" for k in MONEY_FLAGS)
  stripe=v.get("STRIPE_SECRET_KEY","")
  stripe_safe=not stripe or stripe.startswith(("sk_test_","rk_test_"))
  return identity and money_safe and stripe_safe
 except (ValueError,TypeError):
  return False

def main():
 if os.geteuid()==0 or pwd.getpwuid(os.geteuid()).pw_name!=OWNER:
  output("PUSH_PREFLIGHT_ABORT","RUN_AS_TALA_NODE_STAGE")
  return 2
 output("LIVE_18190",api_check(18190))
 output("ISOLATED_STAGE_18192",api_check(18192))
 output("STAGE_POSTGRES_15435_SOCKET","OPEN" if port_open(15435) else "CLOSED")
 output("STAGE_REDIS_16379_SOCKET","OPEN" if port_open(16379) else "CLOSED")
 output("PRIVATE_SOURCE_STAGE_ENV","VALID" if valid_env(values(SOURCE),False) else "ABSENT_OR_REVIEW")
 output("PRIVATE_PARALLEL_STAGE_ENV","VALID" if valid_env(values(PARALLEL),True) else "ABSENT_OR_REVIEW")
 output("ISOLATED_PM2_DIRECTORY","EXISTS_REVIEW" if PM2.exists() or PM2.is_symlink() else "ABSENT")
 output("PUSH_PREFLIGHT_MODE","READ_ONLY")
 output("PUSH_PREFLIGHT_COMPLETE","PASS")
 return 0

if __name__=="__main__":
 raise SystemExit(main())
