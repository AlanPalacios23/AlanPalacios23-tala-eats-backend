#!/usr/bin/env python3
"""Create a separate private STAGING env, never rewrite the existing LIVE or stage env."""
from __future__ import annotations
import os
from pathlib import Path
from urllib.parse import urlsplit
import pwd
import stat
import sys

ROOT=Path("/home/tala-node-stage/.config")
SOURCE=ROOT/"talaeats-node-staging.env"
TARGET=ROOT/"talaeats-node-rc813-parallel.env"

def die(message):
    raise SystemExit("RC813_ENV_ABORT="+message)

def parse(data):
    rows={}
    for line in data.splitlines():
        stripped=line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "=" not in line:
            die("INVALID_LINE")
        key,val=line.split("=",1)
        key=key.strip()
        if not key.isidentifier() or key in rows:
            die("DUPLICATE_OR_INVALID_KEY")
        rows[key]=val.strip().strip('"').strip("'")
    return rows

def main():
    if len(sys.argv)!=2 or sys.argv[1] not in ("--plan","--create"):
        die("USAGE_PLAN_OR_CREATE")
    if os.geteuid()==0 or pwd.getpwuid(os.geteuid()).pw_name!="tala-node-stage":
        die("STAGE_USER_ONLY")
    if (not SOURCE.is_file() or SOURCE.is_symlink() or
        stat.S_IMODE(SOURCE.stat().st_mode)!=0o600 or SOURCE.stat().st_uid!=os.geteuid()):
        die("PRIVATE_STAGE_SOURCE_REQUIRED")
    if TARGET.exists() or TARGET.is_symlink():
        die("TARGET_EXISTS_NEVER_OVERWRITE")
    data=SOURCE.read_text(encoding="utf-8")
    values=parse(data)
    pg=urlsplit(values.get("DATABASE_URL",""))
    rd=urlsplit(values.get("REDIS_URL",""))
    if not (values.get("NODE_ENV")=="staging"
        and values.get("HOST")=="127.0.0.1"
        and values.get("PORT")=="18190"
        and values.get("STRIPE_FINANCIAL_WRITES_ENABLED")=="false"
        and values.get("STRIPE_LIVE_ENABLED")=="false"
        and values.get("STRIPE_CONNECT_TRANSFERS_ENABLED")=="false"
        and pg.hostname=="127.0.0.1" and pg.port==15435
        and pg.username=="tala_node_stage" and pg.path=="/tala_node_stage"
        and rd.hostname=="127.0.0.1" and rd.port==16379
        and rd.path=="/0" and bool(rd.password)
        and values.get("STAGE_PARALLEL_ENABLED","false")=="false"):
        die("STAGING_SOURCE_IDENTITY_MISMATCH")
    for flag in ["STRIPE_REFUNDS_ENABLED","STRIPE_MANUAL_SETTLEMENT_APPROVED",
                 "STRIPE_LIVE_RELEASE_APPROVED","STAGE_STRIPE_TEST_CHECKOUT_ENABLED",
                 "STAGE_DELIVERY_STRIPE_TEST_ENABLED"]:
        if values.get(flag,"false")!="false":
            die("REQUIRE_PAYMENT_FLAGS_OFF")
    if not (values.get("STRIPE_SECRET_KEY","").startswith(("sk_test_","rk_test_"))
            or not values.get("STRIPE_SECRET_KEY","")):
        die("TEST_KEYS_ONLY")
    if not (values.get("STRIPE_PUBLISHABLE_KEY","").startswith("pk_test_")
            or not values.get("STRIPE_PUBLISHABLE_KEY","")):
        die("TEST_PUBLISHABLE_ONLY")
    print("RC813_STAGE_ENV_SOURCE_VALID=PASS")
    print("RC813_STAGE_ENV_TARGET=18192_PG15_REDIS_DB1")
    if sys.argv[1]=="--plan":
        print("RC813_STAGE_ENV_PLAN_ONLY=PASS")
        return
    red=values["REDIS_URL"]
    # URL path is guaranteed exactly /0, retain the scheme/host/credentials.
    from urllib.parse import urlsplit, urlunsplit
    u=urlsplit(red)
    values["REDIS_URL"]=urlunsplit((u.scheme,u.netloc,"/1",u.query,u.fragment))
    values["PORT"]="18192"
    values["STAGE_PARALLEL_ENABLED"]="true"
    # Copy untouched source lines, except validated overrides, to preserve quoting.
    overrides=("PORT","REDIS_URL","STAGE_PARALLEL_ENABLED")
    output=[line for line in data.splitlines() if line.split("=",1)[0].strip() not in overrides]
    output.extend([f"PORT=18192",f"REDIS_URL={values['REDIS_URL']}", "STAGE_PARALLEL_ENABLED=true"])
    fd=os.open(TARGET,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,"w",encoding="utf-8") as file:
        file.write("\n".join(output)+"\n")
    print("RC813_PRIVATE_STAGE_ENV_CREATED=PASS")
    print("RC813_NO_EXISTING_FILE_OR_RUNTIME_CHANGED=YES")

if __name__=="__main__":
    main()
