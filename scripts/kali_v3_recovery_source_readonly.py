#!/usr/bin/env python3
"""Kali V3 recovery source preflight. READ ONLY and private output.

Checks known Compose and env-file existence, declared Docker Postgres env
presence, local PG login with declared init settings; NEVER prints variables,
credential values, DB names, Docker log content or SQL rows.
No migration, process restart, installation, backup, Compose render or writes.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import re
import subprocess

RELEASE=Path("/home/alan/talaeats-releases/TalaEats-Web-v1.6.4-CONNECT-SELF-SERVICE-HF1-LIVE")
LEGACY=Path("/home/alan/talaeats-v3/TalaEats-Web-v3-PRODUCTION")
TEMP=Path("/tmp/tala-deploy-hd4nyo23/release-override.yml")
DB="talaeats-v3-db-1"
API="talaeats-v3-backend-1"
WORKER="talaeats-v3-worker-1"

def run(args,timeout=12):
    return subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                          timeout=timeout,check=False)

def docker_env(container):
    p=run(["docker","inspect","--type","container","--format","{{json .Config.Env}}",container])
    if p.returncode:raise RuntimeError("inspect unavailable")
    rows=json.loads(p.stdout)
    if not isinstance(rows,list):raise RuntimeError("invalid env")
    # Small allowlist; values held in local memory only.
    allowed={"POSTGRES_USER","POSTGRES_DB","POSTGRES_PASSWORD","DATABASE_URL","PGUSER","PGDATABASE","PGPASSWORD"}
    parsed={}
    for s in rows:
        if isinstance(s,str) and "=" in s:
            k,v=s.split("=",1)
            if k in allowed:parsed[k]=v
    return parsed

def source_status():
    for label, root in (("RELEASE",RELEASE),("LEGACY",LEGACY)):
        print(label+"_DIR_PRESENT","yes" if root.is_dir() else "no")
        for filename,tag in ((".env","DOTENV"),(".env.production","DOTENV_PRODUCTION"),("docker-compose.cloudflare.yml","CLOUDFLARE_COMPOSE"),("docker-compose.staging.yml","STAGING_COMPOSE")):
            p=root/filename
            print(label+"_"+tag+"_REGULAR","yes" if p.is_file() and not p.is_symlink() else "no")
    print("RELEASE_TEMP_OVERRIDE_PRESENT","yes" if TEMP.is_file() and not TEMP.is_symlink() else "no")

def config_status(envs):
    for label in ("DB","API","WORKER"):
        env=envs[label]
        for key in (("POSTGRES_USER","POSTGRES_DB","POSTGRES_PASSWORD") if label=="DB" else ("DATABASE_URL",)):
            print(label+"_"+key+"_NONEMPTY","yes" if env.get(key) else "no")

def local_pg_status():
    # This shell reads already-existing environment INSIDE the DB container;
    # stdout/stderr discarded, and no DB names/values forwarded to ChatGPT.
    # 'psql' is read-only and SELECT 1 does not touch application data.
    command='''set -eu
    test -n "${POSTGRES_USER:-}"
    test -n "${POSTGRES_DB:-}"
    psql -X -q -t -A -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'SELECT 1'
    '''
    p=run(["docker","exec",DB,"sh","-c",command],timeout=13)
    print("DB_DECLARED_LOCAL_SELECT1","pass" if p.returncode==0 and p.stdout.strip()==b"1" else "unavailable-or-fail")

def pg_env_consistency(api,worker,db):
    from urllib.parse import unquote,urlsplit
    url=worker.get("DATABASE_URL","")
    try:
        parsed=urlsplit(url)
        user=unquote(parsed.username or "")
        name=unquote(parsed.path.lstrip("/"))
    except (ValueError,TypeError):
        user=name=""
        parsed=None
    # No names emitted. These are only comparisons of declared settings.
    print("WORKER_DATABASE_URL_HAS_USER","yes" if user else "no")
    print("WORKER_DATABASE_URL_HAS_DB","yes" if name else "no")
    print("WORKER_DATABASE_URL_HAS_PASSWORD","yes" if parsed is not None and parsed.password else "no")
    print("API_WORKER_URL_EQUAL","yes" if api.get("DATABASE_URL") and api.get("DATABASE_URL")==url else "no-or-missing")
    if db.get("POSTGRES_USER"):
        print("WORKER_USER_MATCH_DB_DECLARED","yes" if user and user==db["POSTGRES_USER"] else "no")
    else:print("WORKER_USER_MATCH_DB_DECLARED","unknown")
    if db.get("POSTGRES_DB"):
        print("WORKER_DB_MATCH_DB_DECLARED","yes" if name and name==db["POSTGRES_DB"] else "no")
    else:print("WORKER_DB_MATCH_DB_DECLARED","unknown")

def main():
    print("TALA_V3_RECOVERY_SOURCE_BEGIN")
    source_status()
    try:
        envs={label:docker_env(container) for label,container in
              (("DB",DB),("API",API),("WORKER",WORKER))}
        config_status(envs)
        pg_env_consistency(envs["API"],envs["WORKER"],envs["DB"])
    except (RuntimeError,OSError,subprocess.TimeoutExpired,ValueError,TypeError):
        print("DOCKER_EFFECTIVE_CONFIG_UNAVAILABLE")
    try:
        local_pg_status()
    except (OSError,subprocess.TimeoutExpired):
        print("DB_DECLARED_LOCAL_SELECT1 unavailable-or-fail")
    print("NO_SECRET_VALUES_NO_DB_ROWS_NO_PRODUCTION_WRITES")
    print("TALA_V3_RECOVERY_SOURCE_END")

if __name__=="__main__":
    main()
