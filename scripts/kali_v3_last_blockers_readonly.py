#!/usr/bin/env python3
"""TALA EATS — read-only V3 final blocker classification.

Confirms names (NOT values) of base-vs-live env mismatches, image policy and
categorizes why Compose dry-run failed. No Docker changes or secret output.
"""
import json
import re
import subprocess
from pathlib import Path

ROOT=Path("/home/alan/talaeats-releases/TalaEats-Web-v1.6.4-CONNECT-SELF-SERVICE-HF1-LIVE")
PROJECT="talaeats-v3"
COMPOSE=ROOT/"docker-compose.cloudflare.yml"
ENV=ROOT/".env.production"

CATEGORIES=[
  ("UNSUPPORTED_DRY_RUN",r"unknown flag: --dry-run|unknown flag.*dry-run|unknown command.*dry-run"),
  ("IMAGE_NOT_AVAILABLE",r"no such image|unable to find image|image.*not found|pull access denied|manifest unknown"),
  ("BUILD_REQUIRED",r"requires build|image must be built|no image to pull|cannot find image"),
  ("INVALID_COMPOSE_CONFIG",r"invalid compose project|invalid interpolation|service.*has neither.*image nor.*build|invalid reference format"),
  ("UNAVAILABLE_NETWORK",r"network.*not found|no such network"),
  ("VOLUME_PATH_ERROR",r"mount.*not found|bind source path does not exist|invalid mount"),
  ("PERMISSION_DENIED",r"permission denied|access denied"),
  ("SERVICE_UNAVAILABLE",r"no such service|service.*not found"),
  ("DAEMON_UNAVAILABLE",r"cannot connect to the docker daemon|docker daemon is not running"),
]

def execute(args,timeout=30):
    return subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout,check=False)

def env_map(items):
    found={}
    for row in items if isinstance(items,list) else []:
        if isinstance(row,str) and "=" in row:
            key,value=row.split("=",1)
            found[key]=value
    return found

def difference_keys(base,live):
    keys=[k for k,v in base.items()
          if k!="DATABASE_URL" and str(v)!=live.get(k)]
    return sorted(k for k in keys if re.fullmatch(r"[A-Z][A-Z0-9_]{0,70}",k))

def classify(data):
    # Fixed tokens only; NEVER echo original stderr/stdout.
    return [kind for kind,pattern in CATEGORIES
            if re.search(pattern,data,re.IGNORECASE)]

def main():
    print("TALA_V3_LAST_BLOCKERS_BEGIN")
    try:
        base=["docker","compose","-p",PROJECT,"--project-directory",str(ROOT),
              "--env-file",str(ENV),"-f",str(COMPOSE)]
        p=execute(base+["config","--format","json"])
        if p.returncode!=0:
            print("BASE_COMPOSE_READ_FAIL")
            return
        services=json.loads(p.stdout).get("services") or {}
        for service in ("backend","worker"):
            cfg=services.get(service)
            if not isinstance(cfg,dict):
                print(service.upper()+"_BASE_SERVICE_MISSING")
                continue
            candidate=cfg.get("environment") or {}
            if not isinstance(candidate,dict):
                print(service.upper()+"_BASE_ENV_UNSUPPORTED")
                continue
            result=execute(["docker","inspect","--type","container","--format",
                            "{{json .Config.Env}}",f"talaeats-v3-{service}-1"])
            if result.returncode:
                print(service.upper()+"_LIVE_ENV_UNAVAILABLE")
                continue
            keys=difference_keys(candidate,env_map(json.loads(result.stdout)))
            print(service.upper()+"_OTHER_ENV_DIFF_KEYS",",".join(keys) if keys else "NONE")
            print(service.upper()+"_BASE_HAS_IMAGE","yes" if cfg.get("image") else "no")
            print(service.upper()+"_BASE_HAS_BUILD","yes" if cfg.get("build") else "no")
        cmd=["docker","compose","--dry-run","-p",PROJECT,
             "--project-directory",str(ROOT),"--env-file",str(ENV),
             "-f",str(COMPOSE),"up","--no-deps","--no-build","--pull","never",
             "-d","backend","worker"]
        p=execute(cmd,timeout=40)
        print("DRY_RUN_EXIT","PASS" if p.returncode==0 else "FAIL")
        if p.returncode!=0:
            categories=classify((p.stdout+p.stderr).decode("utf-8","replace")[-40000:])
            print("DRY_RUN_CATEGORIES",",".join(categories) if categories else "UNCLASSIFIED")
        print("RECOVERY_REQUIRES_MANUAL_APPROVAL yes")
    except (OSError,ValueError,TypeError,subprocess.TimeoutExpired):
        print("READONLY_DIAG_UNAVAILABLE")
    finally:
        print("NO_SECRET_VALUES_NO_CONTAINERS_CHANGED")
        print("TALA_V3_LAST_BLOCKERS_END")
if __name__=="__main__":
    main()
