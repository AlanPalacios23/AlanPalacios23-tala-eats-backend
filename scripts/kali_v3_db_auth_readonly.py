#!/usr/bin/env python3
"""Kali V3 API/worker PostgreSQL read-only authenticated SELECT 1.

Runs a fixed SQLAlchemy SELECT 1 in the already-running V3 worker only.
Never prints Docker environment, DB URLs, credentials, SQL errors or row data.
NO migrations, changes to Docker, writes, restarts, or privileged access.
"""
from __future__ import annotations
import hmac
import json
import re
import subprocess

API="talaeats-v3-backend-1"
WORKER="talaeats-v3-worker-1"
DB="talaeats-v3-db-1"
PREFIX=("DB_SELECT1_PASS","DB_SELECT1_FAIL","DB_URL_MISSING","DB_URL_NOT_POSTGRES",
        "DB_SQLSTATE","DB_EXCEPTION_CLASS")
SAFE_STATES={"yes","no","missing","unavailable"}

WORKER_PYTHON = r'''
import os
import re
try:
    from sqlalchemy import create_engine
except Exception:
    print("DB_SELECT1_FAIL")
    print("DB_EXCEPTION_CLASS ImportFailure")
    raise SystemExit(0)
url=os.environ.get("DATABASE_URL","")
if not url:
    print("DB_URL_MISSING")
    raise SystemExit(0)
if not url.startswith(("postgresql://","postgresql+psycopg://","postgresql+psycopg2://")):
    print("DB_URL_NOT_POSTGRES")
    raise SystemExit(0)
try:
    engine=create_engine(
        url,
        connect_args={"connect_timeout":5, "options":"-c default_transaction_read_only=on"},
        pool_pre_ping=False,
    )
    with engine.connect() as conn:
        value=conn.exec_driver_sql("SELECT 1").scalar()
    if value == 1:
        print("DB_SELECT1_PASS")
    else:
        print("DB_SELECT1_FAIL")
        print("DB_EXCEPTION_CLASS UnexpectedScalar")
    engine.dispose()
except Exception as exc:
    print("DB_SELECT1_FAIL")
    orig=getattr(exc,"orig",exc)
    name=type(orig).__name__
    if re.fullmatch("[A-Za-z][A-Za-z0-9_]{0,60}",name):
        print("DB_EXCEPTION_CLASS",name)
    sqlstate=getattr(orig,"sqlstate",None) or getattr(orig,"pgcode",None)
    if isinstance(sqlstate,str) and re.fullmatch("[A-Z0-9]{5}",sqlstate):
        print("DB_SQLSTATE",sqlstate)
'''

def docker(*args,timeout=14):
    return subprocess.run(["docker",*args],stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE,timeout=timeout,check=False)

def private_env(container):
    result=docker("inspect","--type","container","--format","{{json .Config.Env}}",container)
    if result.returncode:
        return {}
    items=json.loads(result.stdout)
    env={}
    if isinstance(items,list):
        for item in items:
            if isinstance(item,str) and "=" in item:
                key,value=item.split("=",1)
                if key in {"DATABASE_URL","ENVIRONMENT","AUTO_MIGRATE_ON_START"}:
                    env[key]=value
    return env

def sanitized_status(stdout: bytes):
    # Whitelist anchored lines only. Never echo arbitrary stdout/stderr.
    accepted=[]
    for row in stdout.decode("utf-8","replace").splitlines():
        if row in PREFIX[:4]:
            accepted.append(row)
        elif row.startswith("DB_SQLSTATE ") and re.fullmatch("DB_SQLSTATE [A-Z0-9]{5}",row):
            accepted.append(row)
        elif row.startswith("DB_EXCEPTION_CLASS ") and re.fullmatch("DB_EXCEPTION_CLASS [A-Za-z][A-Za-z0-9_]{0,60}",row):
            accepted.append(row)
    return accepted

def compare_urls(a,b):
    if not a or not b:return "missing"
    return "yes" if hmac.compare_digest(a,b) else "no"

def main():
    print("TALA_V3_DB_AUTH_SAFE_BEGIN")
    try:
        api=private_env(API)
        worker=private_env(WORKER)
        print("API_WORKER_DATABASE_URL_EQUAL", compare_urls(api.get("DATABASE_URL"),worker.get("DATABASE_URL")))
        print("API_DB_URL_CONFIGURED", "yes" if api.get("DATABASE_URL") else "no")
        print("WORKER_DB_URL_CONFIGURED", "yes" if worker.get("DATABASE_URL") else "no")
    except (OSError,ValueError,TypeError,subprocess.TimeoutExpired):
        print("DOCKER_INSPECT_UNAVAILABLE")
    try:
        result=docker("exec",WORKER,"python","-c",WORKER_PYTHON,timeout=20)
        lines=sanitized_status(result.stdout)
        if result.returncode or not lines:
            print("WORKER_READONLY_SELECT1", "unavailable")
        else:
            print("WORKER_READONLY_SELECT1", "attempted")
            for line in lines:
                print(line)
    except (OSError,subprocess.TimeoutExpired):
        print("WORKER_READONLY_SELECT1", "unavailable")
    print("NO_DB_PASSWORDS_NO_RAW_LOGS_NO_SQL_WRITES")
    print("TALA_V3_DB_AUTH_SAFE_END")

if __name__=="__main__":
    main()
