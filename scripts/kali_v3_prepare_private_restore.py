#!/usr/bin/env python3
"""TALA EATS V3 — prepare a PRIVATE restore candidate, never deploy it.

Reads Docker V3 container metadata plus rendered base Compose in memory.
Builds a 0600 local-only candidate override pinning the exact existing images,
sets the DB connection from validated base, preserves LIVE REDIS_URL, performs
Compose config validation and --dry-run only. Does NOT recreate anything.

Never prints URLs, passwords, container env, rendered YAML, raw errors or
secrets. Candidate stays in ~/.local/share/talaeats/v3-recovery-private, which
MUST NOT be added to a public GitHub repo. Always seek explicit authorization
and verified restorable backups before running an actual Compose up.
"""
from __future__ import annotations
import json, os, re, stat, subprocess
from pathlib import Path
from urllib.parse import urlsplit,unquote

ROOT=Path("/home/alan/talaeats-releases/TalaEats-Web-v1.6.4-CONNECT-SELF-SERVICE-HF1-LIVE")
ENV=ROOT/".env.production"
BASE=ROOT/"docker-compose.cloudflare.yml"
PROJECT="talaeats-v3"
C={"backend":"talaeats-v3-backend-1","worker":"talaeats-v3-worker-1"}
DB="talaeats-v3-db-1"
DEST=Path.home()/".local/share/talaeats/v3-recovery-private"
OUT=DEST/"v3-api-worker-restore-candidate.yml"

def execute(args,timeout=22):
    return subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                          timeout=timeout,check=False)

def checked(args,timeout=22):
    p=execute(args,timeout)
    if p.returncode!=0:
        raise RuntimeError("operation unavailable")
    return p.stdout

def dj(name,field):
    return json.loads(checked(["docker","inspect","--type","container","--format",field,name]))

def env_dict(rows):
    return dict(row.split("=",1) for row in rows if isinstance(row,str) and "=" in row)

def valid_postgres_url(url,db):
    if not isinstance(url,str) or not url or "$" in url:
        return False
    try:
        u=urlsplit(url)
        return bool(
            u.scheme.startswith("postgresql") and
            (u.hostname or "").lower() in ("db",DB) and
            (u.port or 5432)==5432 and
            unquote(u.username or "")==db.get("POSTGRES_USER") and
            unquote(u.password or "")==db.get("POSTGRES_PASSWORD") and
            unquote(u.path.lstrip("/"))==db.get("POSTGRES_DB") and
            u.username and u.password and u.path.lstrip("/")
        )
    except (ValueError,TypeError):
        return False

def literal(value):
    # Compose interprets $ even in YAML strings; $$ preserves a literal $.
    return json.dumps(value.replace("$","$$"),ensure_ascii=True)

def build_overlay(services):
    lines=["services:"]
    for name in ("backend","worker"):
        values=services[name]
        lines += [
            "  "+name+":",
            "    image: "+literal(values["image"]),
            "    environment:",
            "      DATABASE_URL: "+literal(values["DATABASE_URL"]),
            "      REDIS_URL: "+literal(values["REDIS_URL"]),
        ]
    return "\n".join(lines)+"\n"

def clean_redis_url(url):
    # REDIS_URL is sensitive. Do not echo any component.
    if not isinstance(url,str) or not url or "$" in url:
        return False
    try:
        u=urlsplit(url)
        return u.scheme in ("redis","rediss") and bool(u.hostname) and (u.port or 6379)>0
    except (TypeError,ValueError):return False

def main():
    print("TALA_V3_RECOVERY_PREP_BEGIN")
    try:
        if not (BASE.is_file() and ENV.is_file()) or BASE.is_symlink() or ENV.is_symlink():
            print("SOURCE_REJECTED")
            return
        basecmd=["docker","compose","-p",PROJECT,
                 "--project-directory",str(ROOT),"--env-file",str(ENV),
                 "-f",str(BASE)]
        rendered=json.loads(checked(basecmd+["config","--format","json"],timeout=30))
        config=rendered.get("services") or {}
        db_env=env_dict(dj(DB,"{{json .Config.Env}}"))
        db_labels=dj(DB,"{{json .Config.Labels}}")
        if db_labels.get("com.docker.compose.project")!=PROJECT or db_labels.get("com.docker.compose.service")!="db":
            print("DB_IDENTITY_REJECTED")
            return
        for key in ("POSTGRES_USER","POSTGRES_DB","POSTGRES_PASSWORD"):
            if not db_env.get(key):
                print("DB_DECLARED_CONFIG_INCOMPLETE")
                return
        desired={}
        for name,container in C.items():
            if name not in config:
                print(name.upper()+"_MISSING_IN_BASE")
                return
            existing=dj(container,"{{json .Config}}")
            labels=existing.get("Labels") or {}
            if labels.get("com.docker.compose.project")!=PROJECT or labels.get("com.docker.compose.service")!=name:
                print(name.upper()+"_IDENTITY_REJECTED")
                return
            base_service=config[name]
            base_env=base_service.get("environment") or {}
            if not isinstance(base_env,dict):
                print(name.upper()+"_BASE_ENV_UNSUPPORTED")
                return
            current=env_dict(existing.get("Env") or [])
            url=base_env.get("DATABASE_URL")
            redis=current.get("REDIS_URL")
            if not valid_postgres_url(url,db_env):
                print(name.upper()+"_DB_URL_REJECTED")
                return
            if not clean_redis_url(redis):
                print(name.upper()+"_REDIS_URL_REJECTED")
                return
            diff=[k for k,v in base_env.items()
                  if k not in ("DATABASE_URL","REDIS_URL")
                  and current.get(k)!=str(v)]
            if diff:
                print(name.upper()+"_OTHER_ENV_PARITY_BLOCKED")
                return
            image=dj(container,"{{json .Image}}")
            if not isinstance(image,str) or not re.fullmatch(r"sha256:[a-f0-9]{64}",image):
                print(name.upper()+"_IMAGE_ID_REJECTED")
                return
            available=execute(["docker","image","inspect","--format","{{.Id}}",image])
            if available.returncode or available.stdout.decode().strip()!=image:
                print(name.upper()+"_IMAGE_NOT_CACHED")
                return
            desired[name]={"image":image,"DATABASE_URL":url,"REDIS_URL":redis}
            print(name.upper()+"_CURRENT_IMAGE_PIN_READY yes")
            print(name.upper()+"_DB_URL_BASE_CORRECT yes")
            print(name.upper()+"_REDIS_URL_PRESERVED yes")
        # The preview does not replace a data backup or omitted original override.
        os.umask(0o077)
        DEST.mkdir(parents=True,exist_ok=True,mode=0o700)
        if DEST.is_symlink():
            print("PRIVATE_DEST_REJECTED")
            return
        os.chmod(DEST,0o700)
        text=build_overlay(desired)
        if OUT.exists() or OUT.is_symlink():
            print("PRIVATE_OVERRIDE_ALREADY_EXISTS_NO_OVERWRITE")
            return
        flags=os.O_CREAT|os.O_EXCL|os.O_WRONLY
        if hasattr(os,"O_NOFOLLOW"): flags |= os.O_NOFOLLOW
        fd=os.open(OUT,flags,0o600)
        with os.fdopen(fd,"w",encoding="utf-8") as stream:
            stream.write(text)
        os.chmod(OUT,0o600)
        print("PRIVATE_OVERRIDE_CREATED yes")
        print("PRIVATE_OVERRIDE_MODE_0600", "yes" if stat.S_IMODE(OUT.stat().st_mode)==0o600 else "no")
        full=basecmd+["-f",str(OUT)]
        p=execute(full+["config","--format","json"],timeout=30)
        if p.returncode:
            print("CANDIDATE_RESOLVED_CONFIG FAIL")
            return
        cfg=json.loads(p.stdout)["services"]
        for name in C:
            c=cfg[name]
            e=c.get("environment") or {}
            exact=(isinstance(e,dict) and
                   e.get("DATABASE_URL")==desired[name]["DATABASE_URL"] and
                   e.get("REDIS_URL")==desired[name]["REDIS_URL"] and
                   c.get("image")==desired[name]["image"])
            print(name.upper()+"_CANDIDATE_VALUES_EXACT", "yes" if exact else "no")
            if not exact:
                print("CANDIDATE_VALIDATION_BLOCKED")
                return
        print("CANDIDATE_RESOLVED_CONFIG PASS")
        dry=execute(["docker","compose","--dry-run","-p",PROJECT,
                     "--project-directory",str(ROOT),"--env-file",str(ENV),
                     "-f",str(BASE),"-f",str(OUT),
                     "up","--no-deps","--no-build","--pull","never","-d",
                     "backend","worker"],timeout=45)
        print("CANDIDATE_DRY_RUN","PASS" if dry.returncode==0 else "FAIL")
        print("PRIVATE_OVERRIDE_LOCATION ~/.local/share/talaeats/v3-recovery-private/v3-api-worker-restore-candidate.yml")
        print("REQUIRES_BACKUP_AND_EXPLICIT_PRODUCTION_AUTHORIZATION yes")
    except (OSError,RuntimeError,ValueError,KeyError,TypeError,subprocess.TimeoutExpired):
        print("PREPARATION_FAIL_CLOSED")
    finally:
        print("NO_PRODUCTION_MUTATIONS_NO_SECRETS_PRINTED")
        print("TALA_V3_RECOVERY_PREP_END")

if __name__=="__main__":
    main()
