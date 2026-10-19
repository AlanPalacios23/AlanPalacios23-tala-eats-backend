#!/usr/bin/env python3
"""TALA EATS V3: read-only DB network/driver diagnostic with redacted output.

No writes, restart, migration, credentials, private hosts, raw exception messages,
or SQL other than SELECT 1. Run from Kali as the current Docker-authorized user.
"""
from __future__ import annotations
import json
import re
import subprocess
from urllib.parse import urlsplit

API="talaeats-v3-backend-1"
WORKER="talaeats-v3-worker-1"
DB="talaeats-v3-db-1"

# Fixed and finite output tokens from the worker. Never relay arbitrary stdout.
OUTCOMES={"PASS", "FAIL", "SKIP", "UNAVAILABLE"}
KINDS={"AUTH_FAILED","PG_HBA_DENIED","ROLE_MISSING","DATABASE_MISSING",
       "DNS_ERROR","TCP_REFUSED","NETWORK_TIMEOUT","NETWORK_UNREACHABLE",
       "CONNECTION_CLOSED","PG_OVERLOADED","SSL_ERROR","PG_STARTING",
       "PARAMETER_ERROR","MISSING_DRIVER","UNKNOWN"}
PATTERNS=(
  ("AUTH_FAILED",r"password authentication failed|invalid password"),
  ("PG_HBA_DENIED",r"no pg_hba\.conf entry"),
  ("ROLE_MISSING",r"role .{0,160} does not exist"),
  ("DATABASE_MISSING",r"database .{0,160} does not exist"),
  ("DNS_ERROR",r"could not translate host name|name or service not known|temporary failure in name resolution"),
  ("TCP_REFUSED",r"connection refused|connect call failed"),
  ("NETWORK_TIMEOUT",r"connection timed out|timeout expired|timed out"),
  ("NETWORK_UNREACHABLE",r"network is unreachable|no route to host"),
  ("CONNECTION_CLOSED",r"server closed the connection unexpectedly|connection is closed|connection reset by peer"),
  ("PG_OVERLOADED",r"too many connections|remaining connection slots|too many clients already"),
  ("SSL_ERROR",r"ssl error|certificate verify failed|tls error"),
  ("PG_STARTING",r"database system is starting up|database system is in recovery mode"),
  ("PARAMETER_ERROR",r"invalid connection option|invalid value for parameter|unrecognized configuration parameter"),
  ("MISSING_DRIVER",r"no module named|can't load plugin"),
)

WORKER_CODE=r'''
import os,re,socket
from urllib.parse import urlsplit
url=os.environ.get("DATABASE_URL","")
def category(exc):
    msg=str(exc)
    for name,pat in (
      ("AUTH_FAILED",r"password authentication failed|invalid password"),
      ("PG_HBA_DENIED",r"no pg_hba\.conf entry"),
      ("ROLE_MISSING",r"role .{0,160} does not exist"),
      ("DATABASE_MISSING",r"database .{0,160} does not exist"),
      ("DNS_ERROR",r"could not translate host name|name or service not known|temporary failure in name resolution"),
      ("TCP_REFUSED",r"connection refused|connect call failed"),
      ("NETWORK_TIMEOUT",r"connection timed out|timeout expired|timed out"),
      ("NETWORK_UNREACHABLE",r"network is unreachable|no route to host"),
      ("CONNECTION_CLOSED",r"server closed the connection unexpectedly|connection is closed|connection reset by peer"),
      ("PG_OVERLOADED",r"too many connections|remaining connection slots|too many clients already"),
      ("SSL_ERROR",r"ssl error|certificate verify failed|tls error"),
      ("PG_STARTING",r"database system is starting up|database system is in recovery mode"),
      ("PARAMETER_ERROR",r"invalid connection option|invalid value for parameter|unrecognized configuration parameter"),
      ("MISSING_DRIVER",r"no module named|can't load plugin"),
    ):
        if re.search(pat,msg,re.I):return name
    return "UNKNOWN"
try:
    from sqlalchemy.engine import make_url
    parsed=make_url(url)
    host=parsed.host
    port=parsed.port or 5432
    if not host or not url.startswith(("postgresql://","postgresql+psycopg://","postgresql+psycopg2://")):
        raise ValueError("unsafe URL")
except Exception:
    print("DB_URL_STATUS FAIL")
    raise SystemExit(0)
try:
    socket.getaddrinfo(host,port,type=socket.SOCK_STREAM)
    print("DNS_STATUS PASS")
except Exception as e:
    print("DNS_STATUS FAIL")
    print("FAIL_KIND",category(e))
    raise SystemExit(0)
try:
    with socket.create_connection((host,port),timeout=5):
        pass
    print("TCP_STATUS PASS")
except Exception as e:
    print("TCP_STATUS FAIL")
    print("FAIL_KIND",category(e))
    raise SystemExit(0)
try:
    from sqlalchemy import create_engine
    # Read-only transaction is enforced by PostgreSQL via libpq connect options.
    engine=create_engine(url,connect_args={"connect_timeout":5,
                           "options":"-c default_transaction_read_only=on"},
                         pool_pre_ping=False)
    with engine.connect() as conn:
        result=conn.exec_driver_sql("SELECT 1").scalar()
    engine.dispose()
    print("SQL_STATUS PASS" if result==1 else "SQL_STATUS FAIL")
except Exception as e:
    print("SQL_STATUS FAIL")
    orig=getattr(e,"orig",e)
    sqlstate=getattr(orig,"sqlstate",None) or getattr(orig,"pgcode",None)
    if isinstance(sqlstate,str) and re.fullmatch(r"[0-9A-Z]{5}",sqlstate):
        print("DB_SQLSTATE",sqlstate)
    print("FAIL_KIND",category(orig))
    # Some psycopg exceptions lack sqlstate and expose the reason only in the
    # SQLAlchemy wrapper. Still classify without printing raw exception text.
    if category(orig)=="UNKNOWN":
        print("WRAPPER_KIND",category(e))
'''

def docker(*args,timeout=12):
    return subprocess.run(["docker",*args],stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE,timeout=timeout,check=False)

def inspect_json(name,template):
    p=docker("inspect","--type","container","--format",template,name)
    if p.returncode:
        raise RuntimeError("Docker metadata unavailable")
    return json.loads(p.stdout)

def network_state(worker,db):
    if not isinstance(worker,dict) or not isinstance(db,dict):
        return False,set()
    shared=set(worker).intersection(db)
    aliases=set()
    for network in shared:
        data=db.get(network) or {}
        aliases.add("talaeats-v3-db-1")
        aliases.update(str(x).lower() for x in (data.get("Aliases") or []) if isinstance(x,str))
    return bool(shared),aliases

def configured_url(items):
    for item in items if isinstance(items,list) else []:
        if isinstance(item,str) and item.startswith("DATABASE_URL="):
            return item[len("DATABASE_URL="):]
    return ""

def parse_allowed_rows(raw):
    allowed=[]
    for line in raw.decode("utf-8","replace").splitlines():
        if re.fullmatch(r"(?:DNS_STATUS|TCP_STATUS|SQL_STATUS|DB_URL_STATUS) (?:PASS|FAIL)",line):
            allowed.append(line)
        elif re.fullmatch(r"FAIL_KIND [A-Z_]+",line) and line.split(" ",1)[1] in KINDS:
            allowed.append(line)
        elif re.fullmatch(r"WRAPPER_KIND [A-Z_]+",line) and line.split(" ",1)[1] in KINDS:
            allowed.append(line)
        elif re.fullmatch(r"DB_SQLSTATE [0-9A-Z]{5}",line):
            allowed.append(line)
    return allowed

def main():
    print("TALA_V3_DB_PATH_BEGIN")
    try:
        worker_networks=inspect_json(WORKER,"{{json .NetworkSettings.Networks}}")
        db_networks=inspect_json(DB,"{{json .NetworkSettings.Networks}}")
        worker_env=inspect_json(WORKER,"{{json .Config.Env}}")
        shared,aliases=network_state(worker_networks,db_networks)
        print("WORKER_DB_NETWORK_SHARED", "yes" if shared else "no")
        url=configured_url(worker_env)
        parsed=urlsplit(url) if url else None
        host=(parsed.hostname or "").lower() if parsed else ""
        port=(parsed.port or 5432) if parsed else None
        allowed=shared and host in aliases and port==5432 and parsed.scheme.startswith("postgresql")
        print("WORKER_DB_ALIAS_MATCH","yes" if allowed else "no")
        if not allowed:
            print("WORKER_TEST_SKIPPED_UNSAFE_TARGET")
            return
        result=docker("exec",WORKER,"python","-c",WORKER_CODE,timeout=25)
        if result.returncode:
            print("WORKER_DIAGNOSTIC_UNAVAILABLE")
        else:
            rows=parse_allowed_rows(result.stdout)
            for row in rows:
                print(row)
            if not rows:
                print("WORKER_DIAGNOSTIC_NO_VALID_OUTPUT")
    except (OSError,ValueError,TypeError,subprocess.TimeoutExpired,RuntimeError):
        print("WORKER_DIAGNOSTIC_UNAVAILABLE")
    finally:
        print("NO_SECRETS_NO_SQL_WRITES_NO_CONTAINER_CHANGES")
        print("TALA_V3_DB_PATH_END")

if __name__=="__main__":
    main()
