#!/usr/bin/env python3
"""TALA EATS — V3 recovery decision gate (READ ONLY, fail closed).

Compares effective API/worker Docker metadata to the original base Compose,
requires a corrected DB URL, checks image identity/mount sources/network names
and performs Docker Compose --dry-run ONLY. NEVER performs actual up/restart,
build/pull, writes, migrations, or outputs credentials / JSON / raw exceptions.
This gate is advisory and NEVER approves a production deploy on its own.
"""
from __future__ import annotations
import json
from pathlib import Path
import subprocess
from urllib.parse import unquote, urlsplit

PROJECT="talaeats-v3"
RELEASE=Path("/home/alan/talaeats-releases/TalaEats-Web-v1.6.4-CONNECT-SELF-SERVICE-HF1-LIVE")
COMPOSE=RELEASE/"docker-compose.cloudflare.yml"
ENVFILE=RELEASE/".env.production"
CONTAINERS={"backend":"talaeats-v3-backend-1","worker":"talaeats-v3-worker-1"}
SHARED=("talaeats-v3-db-1","talaeats-v3-redis-1","talaeats-v3-caddy-1")
GREEN="talaeats-green-api-1"

def run(args, *, timeout=18):
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          check=False, timeout=timeout)

def get(args, *, timeout=18):
    p=run(args,timeout=timeout)
    if p.returncode: raise RuntimeError("Unavailable")
    return p.stdout

def inspect(container,template):
    return json.loads(get(["docker","inspect","--type","container","--format",template,container]))

def env_map(items):
    data={}
    for item in items if isinstance(items,list) else []:
        if isinstance(item,str) and "=" in item:
            key,value=item.split("=",1)
            data[key]=value
    return data

def expected_networks(service, network_def, project=PROJECT):
    configured=service.get("networks")
    if not configured: names=["default"]
    elif isinstance(configured,dict):names=list(configured)
    else:names=list(configured)
    result=set()
    for alias in names:
        n=(network_def or {}).get(alias) or {}
        name=n.get("name") if isinstance(n,dict) else None
        result.add(name or project+"_"+alias)
    return result

def mounted_live(items):
    return {(
        x.get("Type"),
        x.get("Destination"),
        x.get("Name") if x.get("Type")=="volume" else x.get("Source"),
        bool(not x.get("RW",True)),
    ) for x in items if isinstance(x,dict)}

def mounted_candidate(service, volume_defs, project=PROJECT):
    found=set()
    for x in service.get("volumes") or []:
        if not isinstance(x,dict):continue
        type_=x.get("type","volume")
        source=x.get("source")
        if type_=="volume":
            v=volume_defs.get(source) if isinstance(volume_defs,dict) else None
            if isinstance(v,dict):
                source=v.get("name") or project+"_"+source
            elif source:
                source=project+"_"+source
        found.add((type_,x.get("target"),source,bool(x.get("read_only",False))))
    return found

def url_matches(value, db_env):
    if not isinstance(value,str) or not value or "$" in value:
        return False
    try:
        parts=urlsplit(value)
        return (parts.scheme.startswith("postgresql")
                and (parts.hostname or "").lower() in {"db","talaeats-v3-db-1"}
                and (parts.port or 5432)==5432
                and unquote(parts.username or "")==db_env.get("POSTGRES_USER")
                and unquote(parts.password or "")==db_env.get("POSTGRES_PASSWORD")
                and unquote(parts.path.lstrip("/"))==db_env.get("POSTGRES_DB")
                and bool(parts.username and parts.password and parts.path.lstrip("/")))
    except (TypeError,ValueError):return False

def actual_image_matches(service,live):
    image=service.get("image")
    if not image:
        return "unknown"
    # A tag may have moved since container creation. Only exact digest is safe.
    p=run(["docker","image","inspect","--format","{{.Id}}",image])
    if p.returncode:return "no"
    image_id=p.stdout.decode("utf-8","replace").strip()
    return "yes" if image_id==live.get("Image") else "no"

def main():
    print("TALA_V3_RESTORE_GATE_BEGIN")
    failures=[]
    try:
        if not (COMPOSE.is_file() and ENVFILE.is_file()):
            print("RELEASE_SOURCE_FILES ready=no")
            return
        base=["docker","compose","--dry-run","-p",PROJECT,
              "--project-directory",str(RELEASE),"--env-file",str(ENVFILE),
              "-f",str(COMPOSE)]
        normal=[x for x in base if x!="--dry-run"]
        parsed=json.loads(get(normal+["config","--format","json"],timeout=30))
        services=parsed.get("services") or {}
        volume_defs=parsed.get("volumes") or {}
        net_defs=parsed.get("networks") or {}
        if not all(s in services for s in ("backend","worker","db","redis","caddy","frontend")):
            print("BASE_SERVICES_PRESENT no")
            return
        print("BASE_SERVICES_PRESENT yes")
        db_env=env_map(inspect("talaeats-v3-db-1","{{json .Config.Env}}"))
        print("BASE_V3_DB_CREDENTIALS_AVAILABLE", "yes" if all(db_env.get(x) for x in ("POSTGRES_USER","POSTGRES_DB","POSTGRES_PASSWORD")) else "no")
        for service,container in CONTAINERS.items():
            cfg=services[service]
            live_cfg=inspect(container,"{{json .Config}}")
            live_image=inspect(container,"{{json .Image}}")
            live_cfg["ImageID"]=live_image
            mounts=inspect(container,"{{json .Mounts}}")
            networks=inspect(container,"{{json .NetworkSettings.Networks}}")
            labels=live_cfg.get("Labels") or {}
            identity=(labels.get("com.docker.compose.project")==PROJECT
                     and labels.get("com.docker.compose.service")==service)
            print(service.upper()+"_PROJECT_IDENTITY", "yes" if identity else "no")
            if not identity:failures.append(service+"_identity")
            candidate_env=cfg.get("environment") or {}
            if not isinstance(candidate_env,dict):candidate_env=env_map(candidate_env)
            current_env=env_map(live_cfg.get("Env"))
            good_url=url_matches(candidate_env.get("DATABASE_URL"),db_env)
            print(service.upper()+"_BASE_DB_URL_CORRECT", "yes" if good_url else "no")
            if not good_url:failures.append(service+"_url")
            # All explicitly specified base env keys other than corrected URL
            # must match current live values. Report counts only, never keys.
            diff=[k for k,v in candidate_env.items()
                  if k!="DATABASE_URL" and current_env.get(k)!=str(v)]
            print(service.upper()+"_BASE_ENV_OTHER_DIFFERENCES",len(diff))
            if diff: failures.append(service+"_env")
            nm=expected_networks(cfg,net_defs)
            current_names=set(networks or {})
            print(service.upper()+"_BASE_NETWORK_NAMES_MATCH", "yes" if nm==current_names else "no")
            if nm!=current_names:failures.append(service+"_network")
            ml=mounted_live(mounts)
            mc=mounted_candidate(cfg,volume_defs)
            print(service.upper()+"_BASE_MOUNT_SOURCE_AND_TARGET_MATCH","yes" if ml==mc else "no")
            if ml!=mc:failures.append(service+"_mount")
            image=cfg.get("image")
            if image:
                p=run(["docker","image","inspect","--format","{{.Id}}",image],timeout=8)
                img_ok="yes" if p.returncode==0 and p.stdout.decode().strip()==live_image else "no"
            else:img_ok="unknown"
            print(service.upper()+"_BASE_IMAGE_SAME_ID",img_ok)
            if img_ok!="yes":failures.append(service+"_image")
            print(service.upper()+"_CURRENT_IMAGE_CACHED",
                  "yes" if run(["docker","image","inspect","--format","{{.Id}}",live_image],timeout=8).returncode==0 else "no")
            if not cfg.get("image"):print(service.upper()+"_BASE_BUILD_IMAGE_UNPINNED yes")
            # Entrypoint/command changes can trigger migration startup. Fail
            # closed for nontrivial explicit values that differ from runtime.
            for name,key in (("ENTRYPOINT","entrypoint"),("COMMAND","command")):
                effective=live_cfg.get("Entrypoint" if key=="entrypoint" else "Cmd")
                proposed=cfg.get(key)
                compatible=(proposed is None or proposed==effective)
                print(service.upper()+"_BASE_"+name+"_EXPLICIT_COMPATIBLE","yes" if compatible else "no")
                if not compatible:failures.append(service+"_"+key)
        for name in SHARED:
            state=inspect(name,"{{json .State}}")
            print("DEPENDENCY_"+name.split("-")[2].upper()+"_RUNNING",
                  "yes" if state.get("Running") else "no")
            if not state.get("Running"):failures.append("dependency")
        green=inspect(GREEN,"{{json .State}}")
        print("GREEN_RUNNING", "yes" if green.get("Running") else "no")
        if not green.get("Running"):failures.append("green")
        p=run(base+["up","--no-deps","--no-build","--pull","never",
                    "-d","backend","worker"],timeout=35)
        print("COMPOSE_DRY_RUN_RESULT","pass" if p.returncode==0 else "fail")
        if p.returncode:failures.append("dryrun")
        # A dry-run is not a complete parity or backup proof.
        print("STATIC_PARITY_GATE", "pass" if not failures else "blocked")
        print("PRODUCTION_RELEASE_AUTHORIZED no")
    except (RuntimeError,OSError,subprocess.TimeoutExpired,ValueError,TypeError):
        print("STATIC_PARITY_GATE unavailable")
        print("PRODUCTION_RELEASE_AUTHORIZED no")
    finally:
        print("NO_SECRETS_NO_RAW_CONFIG_NO_CONTAINERS_CHANGED")
        print("TALA_V3_RESTORE_GATE_END")

if __name__=="__main__":
    main()
