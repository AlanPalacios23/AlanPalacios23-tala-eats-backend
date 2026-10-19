#!/usr/bin/env python3
"""TALA EATS V3: PostgreSQL DBAPI/session rejection triage, read-only.

Queries only Docker metadata/log text in memory. Execs a fixed Python program
inside the existing V3 worker using psycopg (SELECT 1, read-only).
Prints finite classification strings only, never raw logs, env, DB URLs,
credentials, SQL errors, DB/user names or arbitrary stdout/stderr.
No schema changes, migrations, writes or service restarts.
"""
from __future__ import annotations
import hmac
import json
import re
import subprocess

WORKER="talaeats-v3-worker-1"
DB="talaeats-v3-db-1"
KNOWN={
 "AUTH_PASSWORD_REJECTED":r"password authentication failed|invalid password",
 "AUTH_PASSWORD_ABSENT":r"no password supplied|password is required|password is missing",
 "AUTH_HBA_DENIED":r"no pg_hba\.conf entry|pg_hba reject",
 "AUTH_SCRAM_ERROR":r"scram.*(?:error|failed|require)|sasl.*(?:error|failed)|channel binding.*(?:failed|require)",
 "ROLE_MISSING":r"role .{0,200} does not exist",
 "DATABASE_MISSING":r"database .{0,200} does not exist",
 "CONNECTION_LIMIT":r"too many connections|remaining connection slots|too many clients already",
 "DB_NOT_ACCEPTING":r"database system is starting up|database system is shutting down|database system is in recovery",
 "DNS_FAILED":r"could not translate host name|name or service not known|temporary failure in name resolution",
 "TCP_REFUSED":r"connection refused|connect call failed",
 "TCP_TIMEOUT":r"connection timed out|timeout expired|timed out",
 "NETWORK_UNREACHABLE":r"network unreachable|no route to host",
 "CONNECTION_TERMINATED":r"connection reset by peer|server closed the connection|unexpected eof|connection is closed",
 "SSL_NEGOTIATION_ERROR":r"ssl.*(?:error|failed|invalid|not supported)|tls.*(?:error|failed)|certificate verify failed",
 "CLIENT_PARAM_ERROR":r"invalid connection option|invalid value for parameter|invalid dsn|unrecognized configuration parameter|invalid integer value",
 "CLIENT_DRIVER_MISSING":r"no module named.*psycopg|psycopg module not found",
 "ROLE_PERMISSION_DENIED":r"permission denied for (?:database|schema|table)|must be owner",
 "SQL_READONLY_REJECTION":r"cannot execute .* in a read-only transaction|read-only transaction",
}
SAFE_TOKENS=frozenset(KNOWN)

WORKER_PROGRAM=r'''
import os,re
from sqlalchemy.engine import make_url
try:
    url=make_url(os.environ.get("DATABASE_URL",""))
    if not url.drivername.startswith("postgresql"):
        print("DBAPI_STATUS UNSAFE_URL")
        raise SystemExit(0)
    print("DBAPI_PASSWORD_CONFIGURED","yes" if url.password else "no")
    # No printed URL or private credential. Convert sqlalchemy driver URL into
    # standard libpq URL for direct psycopg DBAPI connection.
    dsn=url.set(drivername="postgresql").render_as_string(hide_password=False)
    import psycopg
    with psycopg.connect(dsn,connect_timeout=6,
                         options="-c default_transaction_read_only=on") as conn:
        with conn.cursor() as cursor:
            cursor.execute("SELECT 1")
            result=cursor.fetchone()
    print("DBAPI_STATUS PASS" if result==(1,) else "DBAPI_STATUS FAIL")
except Exception as error:
    if "url" not in locals():
        print("DBAPI_STATUS UNSAFE_URL")
        raise SystemExit(0)
    print("DBAPI_STATUS FAIL")
    cur=error
    seen=set()
    messages=[]
    sqlstate=None
    for _ in range(4):
        if cur is None or id(cur) in seen: break
        seen.add(id(cur))
        msg=str(cur)
        if msg:messages.append(msg[:16000])
        state=getattr(cur,"sqlstate",None) or getattr(cur,"pgcode",None)
        if isinstance(state,str) and re.fullmatch("[A-Z0-9]{5}",state):
            sqlstate=state
        diag=getattr(cur,"diag",None)
        if diag is not None:
            primary=getattr(diag,"message_primary",None)
            if isinstance(primary,str):
                messages.append(primary[:4000])
        cur=getattr(cur,"__cause__",None) or getattr(cur,"__context__",None)
    if sqlstate:print("DBAPI_SQLSTATE",sqlstate)
    combined="\n".join(messages)
    patterns={
      "AUTH_PASSWORD_REJECTED":r"password authentication failed|invalid password",
      "AUTH_PASSWORD_ABSENT":r"no password supplied|password is required|password is missing",
      "AUTH_HBA_DENIED":r"no pg_hba\.conf entry|pg_hba reject",
      "AUTH_SCRAM_ERROR":r"scram.*(?:error|failed|require)|sasl.*(?:error|failed)|channel binding.*(?:failed|require)",
      "ROLE_MISSING":r"role .{0,200} does not exist",
      "DATABASE_MISSING":r"database .{0,200} does not exist",
      "CONNECTION_LIMIT":r"too many connections|remaining connection slots|too many clients already",
      "DB_NOT_ACCEPTING":r"database system is starting up|database system is shutting down|database system is in recovery",
      "DNS_FAILED":r"could not translate host name|name or service not known|temporary failure in name resolution",
      "TCP_REFUSED":r"connection refused|connect call failed",
      "TCP_TIMEOUT":r"connection timed out|timeout expired|timed out",
      "NETWORK_UNREACHABLE":r"network unreachable|no route to host",
      "CONNECTION_TERMINATED":r"connection reset by peer|server closed the connection|unexpected eof|connection is closed",
      "SSL_NEGOTIATION_ERROR":r"ssl.*(?:error|failed|invalid|not supported)|tls.*(?:error|failed)|certificate verify failed",
      "CLIENT_PARAM_ERROR":r"invalid connection option|invalid value for parameter|invalid dsn|unrecognized configuration parameter|invalid integer value",
      "CLIENT_DRIVER_MISSING":r"no module named.*psycopg|psycopg module not found",
      "ROLE_PERMISSION_DENIED":r"permission denied for (?:database|schema|table)|must be owner",
      "SQL_READONLY_REJECTION":r"cannot execute .* in a read-only transaction|read-only transaction",
    }
    matched=[key for key,pattern in patterns.items() if re.search(pattern,combined,re.I)]
    for key in matched:
        print("DBAPI_REASON",key)
    if not matched:print("DBAPI_REASON UNKNOWN")
    name=type(error).__name__
    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,50}",name):
        print("DBAPI_CLASS",name)
'''

def run(args, timeout=15):
    return subprocess.run(args, stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                          check=False,timeout=timeout)

def metadata(name,template):
    result=run(["docker","inspect","--type","container","--format",template,name])
    if result.returncode:
        raise RuntimeError("Cannot inspect container metadata")
    return json.loads(result.stdout)

def extract_env(items):
    found={}
    for item in items if isinstance(items,list) else []:
        if isinstance(item,str) and "=" in item:
            key,value=item.split("=",1)
            if key in {"DATABASE_URL","POSTGRES_DB","POSTGRES_USER"}:
                found[key]=value
    return found

def compare_pg_metadata(worker_url,db_env):
    try:
        from urllib.parse import urlsplit,unquote
        uri=urlsplit(worker_url)
        if not uri.scheme.startswith("postgresql"):
            return "unknown","unknown"
        user=unquote(uri.username) if uri.username is not None else None
        database=unquote(uri.path.lstrip("/")) if uri.path else None
        expected_user=db_env.get("POSTGRES_USER") or "postgres"
        expected_db=db_env.get("POSTGRES_DB") or expected_user
        return (
            "yes" if user is not None and hmac.compare_digest(user,expected_user) else "no-or-unknown",
            "yes" if database and hmac.compare_digest(database,expected_db) else "no-or-unknown"
        )
    except (ValueError,TypeError):
        return "unknown","unknown"

def classify_log_lines(data):
    # Process the raw DB log in memory only. No snippets, matches or credentials.
    text=data.decode("utf-8","replace")[-400000:]
    return [name for name,pattern in KNOWN.items() if re.search(pattern,text,re.IGNORECASE)]

def safe_worker_output(data):
    lines=[]
    for row in data.decode("utf-8","replace").splitlines():
        if re.fullmatch(r"DBAPI_STATUS (?:PASS|FAIL|UNSAFE_URL)",row):
            lines.append(row)
        elif re.fullmatch(r"DBAPI_PASSWORD_CONFIGURED (?:yes|no)",row):
            lines.append(row)
        elif re.fullmatch(r"DBAPI_SQLSTATE [A-Z0-9]{5}",row):
            lines.append(row)
        elif row.startswith("DBAPI_REASON ") and row[13:] in SAFE_TOKENS | {"UNKNOWN"}:
            lines.append(row)
        elif re.fullmatch(r"DBAPI_CLASS [A-Za-z_][A-Za-z0-9_]{0,50}",row):
            lines.append(row)
    return lines

def main():
    print("TALA_V3_PG_ROOT_CAUSE_BEGIN")
    try:
        worker=extract_env(metadata(WORKER,"{{json .Config.Env}}"))
        db=extract_env(metadata(DB,"{{json .Config.Env}}"))
        user,dbname=compare_pg_metadata(worker.get("DATABASE_URL",""),db)
        print("CONFIG_DECLARED_PG_USER_MATCH",user)
        print("CONFIG_DECLARED_PG_DB_MATCH",dbname)
        # Declared POSTGRES_USER/DB are initialization hints; existing cluster
        # could have changed, so a mismatch does not establish root cause.
    except (RuntimeError,OSError,subprocess.TimeoutExpired,ValueError):
        print("CONFIG_DECLARED_PG_MATCH unavailable")
    try:
        p=run(["docker","exec",WORKER,"python","-c",WORKER_PROGRAM],timeout=24)
        if p.returncode != 0:
            print("WORKER_DBAPI_PROBE unavailable")
        else:
            rows=safe_worker_output(p.stdout)
            if rows:
                for row in rows:print(row)
            else:
                print("WORKER_DBAPI_PROBE unavailable")
    except (OSError,subprocess.TimeoutExpired):
        print("WORKER_DBAPI_PROBE unavailable")
    try:
        p=run(["docker","logs","--tail","180",DB],timeout=13)
        found=classify_log_lines(p.stdout+p.stderr)
        for name in found:
            print("SERVER_LOG_CATEGORY",name)
        if not found:print("SERVER_LOG_CATEGORY NONE_MATCHED")
    except (OSError,subprocess.TimeoutExpired):
        print("SERVER_LOG_CATEGORY unavailable")
    print("NO_RAW_LOGS_NO_CREDENTIALS_NO_DATABASE_MUTATIONS")
    print("TALA_V3_PG_ROOT_CAUSE_END")

if __name__=="__main__":
    main()
