#!/usr/bin/env python3
"""Read-only diagnosis of restart-loop DB failure. Never print Docker logs/secrets."""
from __future__ import annotations
import json
import re
import subprocess

BACKEND = "talaeats-v3-backend-1"
DB = "talaeats-v3-db-1"
CADDY = "talaeats-v3-caddy-1"
ERRORS = (
    ("AUTH_FAILED", r"password authentication failed|invalid password|sqlstate.{0,12}28p01"),
    ("PG_HBA_REJECTED", r"no pg_hba\.conf entry|sqlstate.{0,12}28000"),
    ("ROLE_MISSING", r"role .{0,180} does not exist|sqlstate.{0,12}28000"),
    ("DATABASE_MISSING", r"database .{0,180} does not exist|sqlstate.{0,12}3d000"),
    ("DNS_FAILED", r"could not translate host name|name or service not known|temporary failure in name resolution|nodename nor servname provided"),
    ("TCP_CONNECTION_REFUSED", r"connection refused|connect call failed|actively refused"),
    ("NETWORK_TIMEOUT", r"connection timed out|timeout expired|operation timed out"),
    ("POSTGRES_TOO_MANY_CONNECTIONS", r"too many connections|remaining connection slots are reserved|too many clients already|sqlstate.{0,12}53300"),
    ("POSTGRES_STARTING", r"the database system is starting up|the database system is in recovery mode|sqlstate.{0,12}57p03"),
    ("POSTGRES_SSL_ERROR", r"ssl error|certificate verify failed|sslmode"),
    ("SCHEMA_OR_ROLE_PERMISSION", r"permission denied for (?:database|schema|table)|must be owner of"),
    ("ALEMBIC_MISSING_REVISION", r"can.t locate revision|no such revision|revision .* not present|multiple head revisions"),
    ("ALEMBIC_SCHEMA_DRIFT", r"target database is not up to date|relation .{0,180} already exists|duplicate (?:table|column)|sqlstate.{0,12}42p07"),
    ("POSTGRES_DIALECT_MISSING", r"no module named .{0,180}(?:psycopg|asyncpg)|can't load plugin: sqlalchemy\.dialects"),
)
FALLBACK = (
    ("PYTHON_IMPORT_FAILURE", r"modulenotfounderror|importerror"),
    ("MIGRATION_ACTIVITY_IN_LOG", r"alembic|running upgrade|applying migrations|migration"),
    ("SQLALCHEMY_OPERATIONAL_ERROR", r"operationalerror|psycopg"),
    ("PYTHON_TRACEBACK", r"traceback \(most recent call last\)"),
)

def classify(logs: str) -> list[str]:
    # The actual message may contain hostnames, DB names, account names and secrets.
    # NEVER print excerpts, matches or arbitrary exception text.
    return [name for name, pat in (*ERRORS, *FALLBACK)
            if re.search(pat, logs, re.IGNORECASE)]

def execute(args: list[str], *, timeout: int = 12) -> subprocess.CompletedProcess:
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          check=False, timeout=timeout)

def project_state(name: str):
    try:
        result=execute(["docker","inspect","--type","container","--format",
                        '{{json .State}}',name])
        if result.returncode:
            return "NOT_AVAILABLE"
        data=json.loads(result.stdout)
        return "restarting" if data.get("Status")=="restarting" else (
            "running" if data.get("Running") is True else "not-running")
    except (OSError, subprocess.TimeoutExpired, ValueError, TypeError):
        return "UNKNOWN"

def network_names(name: str) -> set[str]:
    try:
        result=execute(["docker","inspect","--type","container","--format",
                        '{{json .NetworkSettings.Networks}}',name])
        if result.returncode:
            return set()
        data=json.loads(result.stdout)
        return set(data.keys()) if isinstance(data,dict) else set()
    except (OSError, subprocess.TimeoutExpired, ValueError, TypeError):
        return set()

def main():
    print("TALA_V3_PG_DIAG_BEGIN")
    for name in (BACKEND, DB, CADDY):
        print("STATE", name, project_state(name))
    for peer in (DB,CADDY):
        shared=bool(network_names(BACKEND)&network_names(peer))
        print("NETWORK_SHARED", "backend-db" if peer==DB else "backend-caddy", "yes" if shared else "no-or-unknown")

    # pg_isready is only a connection-status check. NO psql, SQL, env reading.
    try:
        result=execute(["docker","exec",DB,"pg_isready","-h","127.0.0.1","-p","5432"],timeout=9)
        print("POSTGRES_LOCAL_READY", "yes" if result.returncode==0 else "no-or-unavailable")
    except (OSError, subprocess.TimeoutExpired):
        print("POSTGRES_LOCAL_READY unknown")

    try:
        result=execute(["docker","logs","--tail","350",BACKEND],timeout=14)
        logs=(result.stdout+result.stderr)[-400000:].decode("utf-8","replace")
        matches=classify(logs)
        if matches:
            for name in matches:
                print("ERROR_CATEGORY",name)
        else:
            print("ERROR_CATEGORY NONE_MATCHED")
        print("LOG_CLASSIFICATION_ONLY_NO_RAW_LOGS")
    except (OSError, subprocess.TimeoutExpired):
        print("LOG_CLASSIFICATION_UNAVAILABLE")
    print("TALA_V3_PG_DIAG_END_READONLY")

if __name__=="__main__":
    main()
