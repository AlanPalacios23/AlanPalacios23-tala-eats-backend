#!/usr/bin/env python3
"""Kali V3: metadata/PG catalog coherence; read-only, fully redacted output.

No secret, URL, username, DB name or SQL row is printed. Database catalog is
queried via psql as OS postgres inside existing V3 DB container. No deploy.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import urlsplit, unquote

NAMES = {
    "API": "talaeats-v3-backend-1",
    "WORKER": "talaeats-v3-worker-1",
    "DB": "talaeats-v3-db-1",
}
ALLOWED_ROOT = Path("/home/alan/talaeats-releases")
PG_SQL = """
SELECT json_build_object(
 'roles', COALESCE((SELECT json_agg(json_build_object('name',rolname,'login',rolcanlogin))
    FROM pg_catalog.pg_roles), '[]'::json),
 'databases', COALESCE((SELECT json_agg(json_build_object('name',datname,'owner',pg_get_userbyid(datdba)))
    FROM pg_catalog.pg_database WHERE datallowconn), '[]'::json)
)::text;
"""

def cmd(arguments, timeout=14):
    return subprocess.run(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          check=False, timeout=timeout)

def docker_meta(container):
    proc=cmd(["docker","inspect","--type","container","--format",
              "{{json .Config}}",container])
    if proc.returncode: raise RuntimeError("Docker Config unavailable")
    obj=json.loads(proc.stdout)
    if not isinstance(obj,dict):raise RuntimeError("Invalid Docker Config")
    labels=obj.get("Labels") or {}
    return {
       "project": labels.get("com.docker.compose.project") or "",
       "service": labels.get("com.docker.compose.service") or "",
       "files": labels.get("com.docker.compose.project.config_files") or "",
       "env": obj.get("Env") or [],
    }

def safe_files(config):
    files=[value.strip() for value in config.split(",") if value.strip()]
    flags=[]
    for file in files:
        p=Path(file)
        flags.append(p.is_file() and not p.is_symlink())
    return len(files),sum(flags),all(flags) if files else False

def env_value(items,key):
    for item in items if isinstance(items,list) else []:
        if isinstance(item,str) and item.startswith(key+"="):
            return item[len(key)+1:]
    return ""

def target_from_url(url):
    try:
        parsed=urlsplit(url)
        if not parsed.scheme.startswith("postgresql"):return None,None
        user=unquote(parsed.username or "")
        db=unquote(parsed.path.lstrip("/").split("/",1)[0])
        return user or None,db or None
    except (ValueError, TypeError, AttributeError):
        return None,None

def catalog_flags(user,dbname,catalog):
    roles={r.get("name"):r for r in catalog.get("roles",[]) if isinstance(r,dict)}
    databases={d.get("name"):d for d in catalog.get("databases",[]) if isinstance(d,dict)}
    return {
        "ROLE_EXISTS": "unknown" if not user else ("yes" if user in roles else "no"),
        "ROLE_CAN_LOGIN": "unknown" if not user or user not in roles else ("yes" if roles[user].get("login") is True else "no"),
        "DATABASE_EXISTS": "unknown" if not dbname else ("yes" if dbname in databases else "no"),
        "DATABASE_OWNER_MATCHES_ROLE": "unknown" if not user or dbname not in databases else ("yes" if databases[dbname].get("owner")==user else "no"),
    }

def collect():
    metas={kind:docker_meta(name) for kind,name in NAMES.items()}
    print("TALA_V3_CATALOG_PREFLIGHT_BEGIN")
    for kind in NAMES:
        entry=metas[kind]
        count,exists,all_exist=safe_files(entry["files"])
        print(kind+"_COMPOSE_PROJECT_V3", "yes" if entry["project"]=="talaeats-v3" else "no")
        print(kind+"_COMPOSE_SERVICE_EXPECTED",
              "yes" if entry["service"]=={"API":"backend","WORKER":"worker","DB":"db"}[kind] else "no")
        print(kind+"_COMPOSE_FILES_PRESENT",str(exists)+"/"+str(count))
        print(kind+"_ALL_COMPOSE_FILES_PRESENT","yes" if all_exist else "no")
    print("API_WORKER_CONFIG_FILES_IDENTICAL",
          "yes" if metas["API"]["files"]==metas["WORKER"]["files"] else "no")
    print("API_DB_CONFIG_FILES_IDENTICAL",
          "yes" if metas["API"]["files"]==metas["DB"]["files"] else "no")
    url=env_value(metas["WORKER"]["env"],"DATABASE_URL")
    user,dbname=target_from_url(url)
    print("WORKER_DB_USERNAME_PRESENT","yes" if user else "no")
    print("WORKER_DB_NAME_PRESENT","yes" if dbname else "no")
    try:
        result=cmd(["docker","exec","-u","postgres",NAMES["DB"],"psql",
                    "-X","-q","-t","-A","-v","ON_ERROR_STOP=1","-d","postgres",
                    "-c",PG_SQL],timeout=15)
        if result.returncode:
            print("PG_CATALOG_QUERY","unavailable")
        else:
            catalog=json.loads(result.stdout.strip())
            for key,val in catalog_flags(user,dbname,catalog).items():
                print("PG_"+key,val)
            print("PG_CATALOG_QUERY","pass")
    except (OSError,subprocess.TimeoutExpired,ValueError,TypeError):
        print("PG_CATALOG_QUERY","unavailable")
    print("NO_CREDENTIALS_NO_ROLE_NAMES_NO_DATABASE_NAMES_NO_MUTATIONS")
    print("TALA_V3_CATALOG_PREFLIGHT_END")

if __name__=="__main__":
    try: collect()
    except (OSError,subprocess.TimeoutExpired,RuntimeError,ValueError,TypeError):
        print("TALA_V3_CATALOG_PREFLIGHT_UNAVAILABLE")
