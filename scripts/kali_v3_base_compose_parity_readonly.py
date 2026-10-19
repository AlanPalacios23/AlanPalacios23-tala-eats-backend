#!/usr/bin/env python3
"""Read-only comparison: v1.6.4 base Compose vs effective Docker V3 API/worker.

All Docker env and rendered Compose values stay in memory. Only fixed flags
are printed. No changes to Docker, Git, service configuration, DB or files.
A successful comparison is NOT authorization to recreate a container.
"""
from __future__ import annotations
import json
from pathlib import Path
import subprocess
from urllib.parse import urlsplit, unquote

PROJECT="talaeats-v3"
RELEASE=Path("/home/alan/talaeats-releases/TalaEats-Web-v1.6.4-CONNECT-SELF-SERVICE-HF1-LIVE")
COMPOSE=RELEASE/"docker-compose.cloudflare.yml"
ENV=RELEASE/".env.production"
CONTAINERS={
  "BACKEND":"talaeats-v3-backend-1",
  "WORKER":"talaeats-v3-worker-1",
  "DB":"talaeats-v3-db-1",
}
SERVICES={"BACKEND":"backend","WORKER":"worker","DB":"db"}

def command(args,timeout=16):
    result=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                          timeout=timeout,check=False)
    if result.returncode:
        raise RuntimeError("inspection unavailable")
    return result.stdout

def docker_json(name, template):
    return json.loads(command(["docker","inspect","--type","container",
                               "--format",template,name]))

def dictionary_env(items):
    if not isinstance(items,list): return {}
    out={}
    for row in items:
        if isinstance(row,str) and "=" in row:
            key,value=row.split("=",1)
            if key in {"DATABASE_URL","POSTGRES_USER","POSTGRES_DB","POSTGRES_PASSWORD",
                       "ENVIRONMENT","AUTO_MIGRATE_ON_START"}:
                out[key]=value
    return out

def value_state(url,reference):
    result={key:"unknown" for key in
            ("USER","PASSWORD","DB","HOST_V3","USER_MATCH_DB","PASSWORD_MATCH_DB","NAME_MATCH_DB")}
    if not isinstance(url,str) or not url or "$" in url:
        return result
    try:
        parsed=urlsplit(url)
        u=unquote(parsed.username or "")
        password=unquote(parsed.password or "")
        database=unquote(parsed.path.lstrip("/"))
        host=(parsed.hostname or "").lower()
        port=parsed.port or 5432
    except (ValueError,TypeError):
        return result
    for key,value in (("USER",u),("PASSWORD",password),("DB",database)):
        result[key]="yes" if value else "no"
    result["HOST_V3"]="yes" if host in {"db","talaeats-v3-db-1"} and port==5432 else "no"
    for key,value,ref in (("USER_MATCH_DB",u,"POSTGRES_USER"),
                          ("PASSWORD_MATCH_DB",password,"POSTGRES_PASSWORD"),
                          ("NAME_MATCH_DB",database,"POSTGRES_DB")):
        reference_value=reference.get(ref)
        result[key]=("unknown" if not value or not reference_value
                     else "yes" if value==reference_value else "no")
    return result

def compose_env(service):
    out=service.get("environment") or {}
    if isinstance(out,dict): return out
    # Docker Compose config generally normalizes env to a mapping.
    return dictionary_env(out)

def mount_targets_live(mounts):
    return {item.get("Destination") for item in mounts
            if isinstance(item,dict) and item.get("Destination")}

def mount_targets_compose(service):
    volumes=service.get("volumes") or []
    return {item.get("target") for item in volumes
            if isinstance(item,dict) and item.get("target")}

def compare():
    print("TALA_V3_BASE_COMPOSE_PARITY_BEGIN")
    if not COMPOSE.is_file() or not ENV.is_file():
        print("SOURCE_FILES_MISSING")
        return
    data=command(["docker","compose","-p",PROJECT,"--project-directory",str(RELEASE),
                  "--env-file",str(ENV),"-f",str(COMPOSE),"config","--format","json"],timeout=20)
    cfg=json.loads(data)
    services=cfg.get("services")
    if not isinstance(services,dict):
        print("COMPOSE_SERVICES_UNAVAILABLE")
        return
    live={label:{
        "config":docker_json(name,"{{json .Config}}"),
        "mounts":docker_json(name,"{{json .Mounts}}"),
        "networks":docker_json(name,"{{json .NetworkSettings.Networks}}")
    } for label,name in CONTAINERS.items()}
    db_env=dictionary_env(live["DB"]["config"].get("Env"))
    for label,service_name in SERVICES.items():
        print(label+"_IN_BASE_COMPOSE","yes" if service_name in services else "no")
    print("REDIS_IN_BASE_COMPOSE","yes" if "redis" in services else "no")
    print("CADDY_IN_BASE_COMPOSE","yes" if "caddy" in services else "no")
    print("FRONTEND_IN_BASE_COMPOSE","yes" if "frontend" in services else "no")
    for label in ("BACKEND","WORKER"):
        service=services.get(SERVICES[label],{})
        if not isinstance(service,dict): service={}
        current=dictionary_env(live[label]["config"].get("Env"))
        candidate=compose_env(service)
        for title,env in (("LIVE",current),("BASE",candidate)):
            flags=value_state(env.get("DATABASE_URL"),db_env)
            for key,value in flags.items():
                print(label+"_"+title+"_URL_"+key,value)
        print(label+"_BASE_ENVIRONMENT_MATCH_LIVE",
              "yes" if candidate.get("ENVIRONMENT")==current.get("ENVIRONMENT")
              else "no-or-unresolved")
        print(label+"_BASE_AUTO_MIGRATE_MATCH_LIVE",
              "yes" if candidate.get("AUTO_MIGRATE_ON_START")==current.get("AUTO_MIGRATE_ON_START")
              else "no-or-unresolved")
        target_live=mount_targets_live(live[label]["mounts"])
        target_compose=mount_targets_compose(service)
        print(label+"_BASE_MOUNT_TARGETS_MATCH_LIVE",
              "yes" if target_live==target_compose else "no")
        print(label+"_LIVE_NETWORK_COUNT",len(live[label]["networks"] or {}))
        print(label+"_BASE_NETWORK_COUNT",len(service.get("networks") or {}))
        image=service.get("image")
        live_image=live[label]["config"].get("Image")
        print(label+"_BASE_IMAGE_TAG_MATCH_LIVE",
              "unknown" if not image else "yes" if image==live_image else "no")
    print("PARITY_PASS_NOT_ESTABLISHED_MISSING_OVERRIDE")
    print("NO_VALUES_NO_SECRETS_NO_MUTATIONS")
    print("TALA_V3_BASE_COMPOSE_PARITY_END")

if __name__=="__main__":
    try: compare()
    except (OSError,ValueError,TypeError,RuntimeError,subprocess.TimeoutExpired):
        print("TALA_V3_BASE_COMPOSE_PARITY_UNAVAILABLE")
