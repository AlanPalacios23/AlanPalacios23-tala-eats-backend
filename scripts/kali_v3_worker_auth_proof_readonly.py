#!/usr/bin/env python3
"""TALA EATS — prove existing V3 PostgreSQL credentials from existing V3 worker.

Strictly a read-only diagnostic. PostgreSQL credentials are read only in local
memory from the already-running DB container and passed as JSON on standard
input to a fixed Python process in the worker. Never appear on the command
line, in a new file, printed output or GitHub. No restart, migration or writes.
Requires the approved Docker Compose V3 project and shared Docker network.
"""
from __future__ import annotations

import json
import re
import subprocess

DB = "talaeats-v3-db-1"
WORKER = "talaeats-v3-worker-1"
PROJECT = "talaeats-v3"

PROBE = r'''
import json, re, sys
params=json.loads(sys.stdin.read(16000))
try:
    import psycopg
except ImportError:
    print("AUTH_PROBE_DRIVER_MISSING")
    raise SystemExit(0)
try:
    with psycopg.connect(host=params["host"],
                         port=5432,
                         user=params["user"],
                         password=params["password"],
                         dbname=params["database"],
                         connect_timeout=6,
                         options="-c default_transaction_read_only=on") as conn:
        with conn.cursor() as cur:
            cur.execute("SHOW transaction_read_only")
            readonly=cur.fetchone()[0]
            cur.execute("SELECT 1")
            result=cur.fetchone()
    print("WORKER_AUTH_SELECT1_PASS" if readonly=="on" and result==(1,)
          else "WORKER_AUTH_SELECT1_FAIL")
except Exception as error:
    print("WORKER_AUTH_SELECT1_FAIL")
    code=getattr(error, "sqlstate", None)
    if isinstance(code,str) and re.fullmatch(r"[0-9A-Z]{5}",code):
        print("PG_SQLSTATE",code)
    msg=str(error)
    markers=(
       ("PG_PASSWORD_REJECTED",r"password authentication failed"),
       ("PG_ROLE_MISSING",r"role .{0,160} does not exist"),
       ("PG_DATABASE_MISSING",r"database .{0,160} does not exist"),
       ("PG_HBA_DENIED",r"no pg_hba\.conf entry"),
       ("PG_NETWORK_OR_TIMEOUT",r"connection refused|timed out|no route to host"),
       ("PG_CONNECTION_CLOSED",r"server closed the connection|connection reset by peer"),
       ("PG_TOO_MANY_CONNECTIONS",r"too many connections|remaining connection slots"),
    )
    for key,pattern in markers:
        if re.search(pattern,msg,re.I):
            print("PG_FAILURE_CATEGORY",key)
'''

ALLOWED_STATUS={"WORKER_AUTH_SELECT1_PASS","WORKER_AUTH_SELECT1_FAIL",
                "AUTH_PROBE_DRIVER_MISSING"}
ALLOWED_REASONS={"PG_PASSWORD_REJECTED","PG_ROLE_MISSING","PG_DATABASE_MISSING",
                 "PG_HBA_DENIED","PG_NETWORK_OR_TIMEOUT","PG_CONNECTION_CLOSED",
                 "PG_TOO_MANY_CONNECTIONS"}

def docker(args, *, timeout=14, payload=None):
    return subprocess.run(["docker",*args],input=payload,
                          stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                          timeout=timeout,check=False)

def inspect(container,field):
    result=docker(["inspect","--type","container","--format",field,container])
    if result.returncode:
        raise RuntimeError("Docker metadata not available")
    return json.loads(result.stdout)

def env_subset(rows):
    keep={"POSTGRES_USER","POSTGRES_DB","POSTGRES_PASSWORD"}
    out={}
    if not isinstance(rows,list):
        raise ValueError("Invalid Docker environment")
    for row in rows:
        if isinstance(row,str) and "=" in row:
            k,v=row.split("=",1)
            if k in keep:
                out[k]=v
    return out

def target_alias(worker_nets, db_nets):
    if not isinstance(worker_nets,dict) or not isinstance(db_nets,dict):
        return None
    for network in sorted(set(worker_nets)&set(db_nets)):
        db_data=db_nets.get(network) or {}
        aliases=set(db_data.get("Aliases") or [])
        for safe in ("db",DB):
            if safe in aliases:
                return safe
    return None

def safe_rows(raw):
    out=[]
    for row in raw.decode("utf-8","replace").splitlines():
        if row in ALLOWED_STATUS:
            out.append(row)
        elif re.fullmatch(r"PG_SQLSTATE [A-Z0-9]{5}",row):
            out.append(row)
        elif row.startswith("PG_FAILURE_CATEGORY ") and row[20:] in ALLOWED_REASONS:
            out.append(row)
    return out

def run_probe():
    print("TALA_V3_WORKER_AUTH_BEGIN")
    try:
        db_labels=inspect(DB,"{{json .Config.Labels}}")
        worker_labels=inspect(WORKER,"{{json .Config.Labels}}")
        if not (db_labels.get("com.docker.compose.project")==PROJECT
                and worker_labels.get("com.docker.compose.project")==PROJECT
                and db_labels.get("com.docker.compose.service")=="db"
                and worker_labels.get("com.docker.compose.service")=="worker"):
            print("V3_COMPOSE_IDENTITY_MISMATCH")
            return

        host=target_alias(inspect(WORKER,"{{json .NetworkSettings.Networks}}"),
                          inspect(DB,"{{json .NetworkSettings.Networks}}"))
        if not host:
            print("V3_SHARED_DB_ALIAS_NOT_CONFIRMED")
            return

        env=env_subset(inspect(DB,"{{json .Config.Env}}"))
        credentials={
            "host":host,
            "user":env.get("POSTGRES_USER",""),
            "database":env.get("POSTGRES_DB",""),
            "password":env.get("POSTGRES_PASSWORD",""),
        }
        if not all(credentials.values()):
            print("V3_DB_DECLARED_CREDENTIALS_INCOMPLETE")
            return
        print("V3_COMPOSE_IDENTITY_CONFIRMED")
        print("V3_WORKER_DB_NETWORK_CONFIRMED")
        result=docker(["exec","-i",WORKER,"python","-c",PROBE],
                      timeout=22,payload=json.dumps(credentials).encode("utf-8"))
        # Explicitly no display of stdout/stderr unless allowlisted.
        if result.returncode:
            print("V3_WORKER_AUTH_PROBE_UNAVAILABLE")
            return
        rows=safe_rows(result.stdout)
        for row in rows:
            print(row)
        if not rows:
            print("V3_WORKER_AUTH_PROBE_UNAVAILABLE")
    except (RuntimeError,ValueError,TypeError,OSError,subprocess.TimeoutExpired):
        print("V3_WORKER_AUTH_PROBE_UNAVAILABLE")
    finally:
        print("NO_PASSWORD_OUTPUT_NO_FILES_NO_DB_WRITES_NO_RESTART")
        print("TALA_V3_WORKER_AUTH_END")

if __name__=="__main__":
    run_probe()
