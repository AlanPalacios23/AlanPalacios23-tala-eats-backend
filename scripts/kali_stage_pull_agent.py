#!/usr/bin/env python3
"""Outbound, tokenless GitHub poller for Kali staging. No incoming SSH or production."""
from __future__ import annotations
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.request

API = "https://api.github.com/repos/AlanPalacios23/AlanPalacios23-tala-eats-backend"
WORKFLOW = "kali-stage-approve.yml"
APPROVER = "AlanPalacios23"
CHECKS = frozenset({
    "syntax-check",
    "Sintaxis + secretos (solo código)",
    "pytest FastAPI + SQLite aislado",
    "PostgreSQL 16 + Redis 8 + Alembic (datos efímeros)",
    "PostgreSQL 16 + Redis 8 + contratos financieros",
    "PyPI OSV + Bandit static checks (read-only)",
    "Real PM2 + FastAPI + worker, native PostgreSQL/Redis, isolated",
})

def fetch(path):
    if not path.startswith("/") or ".." in path or "//" in path:
        raise ValueError("Invalid API path")
    request = urllib.request.Request(API+path, headers={
        "User-Agent":"TalaEats-Kali-Stage-Agent/1.0",
        "Accept":"application/vnd.github+json"})
    with urllib.request.urlopen(request, timeout=15) as response:
        if response.status != 200:
            raise ValueError("Unexpected GitHub status")
        data=json.loads(response.read(500000))
    if not isinstance(data,dict):
        raise ValueError("Invalid JSON response")
    return data

def select_approval(runs, sha, last_id, now):
    eligible=[]
    for item in runs:
        if not isinstance(item,dict): continue
        if not isinstance(item.get("actor"),dict): continue
        if (item["actor"].get("login")!=APPROVER
            or item.get("event")!="workflow_dispatch"
            or item.get("head_branch")!="main"
            or item.get("head_sha")!=sha
            or item.get("status")!="completed"
            or item.get("conclusion")!="success"
            or not isinstance(item.get("id"),int)
            or isinstance(item.get("id"),bool)
            or item["id"]<=last_id):
            continue
        try:
            created=datetime.fromisoformat(item["created_at"].replace("Z","+00:00"))
            age=now-created
        except (ValueError,KeyError,AttributeError,TypeError):
            continue
        if timedelta(0)<=age<=timedelta(hours=4):
            eligible.append(item)
    return max(eligible,key=lambda i:i["id"],default=None)

def checks_pass(items,sha):
    latest={}
    for item in items:
        if not isinstance(item,dict): continue
        name=item.get("name")
        if name in CHECKS and item.get("head_sha")==sha:
            if name not in latest or item.get("id",0)>latest[name].get("id",0):
                latest[name]=item
    return all(latest.get(name,{}).get("conclusion")=="success"
               and latest[name].get("status")=="completed"
               and latest[name].get("app",{}).get("slug")=="github-actions"
               for name in CHECKS)

def protected(path):
    return (path.is_file() and not path.is_symlink()
            and path.stat().st_uid==os.getuid()
            and path.stat().st_mode & 0o777==0o600)

def read_last(path):
    if not path.exists(): return 0
    if not protected(path): raise PermissionError("Invalid state permissions")
    value=json.loads(path.read_text()).get("last_id",0)
    if not isinstance(value,int) or isinstance(value,bool) or value<0:
        raise ValueError("Invalid state")
    return value

def consume(path,run_id,sha):
    path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    if (path.parent.is_symlink()
        or path.parent.stat().st_uid!=os.getuid()
        or path.parent.stat().st_mode & 0o777!=0o700):
        raise PermissionError("Unsafe state directory")
    if path.exists() and not protected(path):
        raise PermissionError("Unsafe state file")
    fd,tmp=tempfile.mkstemp(dir=path.parent,prefix=".kali-agent-")
    try:
        with os.fdopen(fd,"w") as stream:
            json.dump({"last_id":run_id,"sha":sha},stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(tmp,0o600)
        os.replace(tmp,path)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)

def poll(home,apply=False,get=fetch,execute=subprocess.run,now=None):
    if os.getuid()==0:
        raise PermissionError("Staging agent cannot run as root")
    if home.resolve()!=Path.home().resolve():
        raise ValueError("Wrong home")
    repo=home/"tala-eats-pm2-stage"
    if not repo.is_dir():return "STAGING_NOT_INSTALLED"
    config=home/".config/talaeats-kali-stage-agent.json"
    enabled=protected(config) and json.loads(config.read_text())=={"enable_staging_deploy":True}
    if not apply or not enabled:return "STAGING_DEPLOY_DISABLED"
    state=home/".local/state/talaeats-stage-agent/state.json"
    last_id=read_last(state)
    sha=get("/branches/main")["commit"]["sha"]
    if not isinstance(sha,str) or not re.fullmatch("[0-9a-f]{40}",sha):
        raise ValueError("Invalid main SHA")
    response=get("/actions/workflows/"+WORKFLOW+"/runs?event=workflow_dispatch&branch=main&per_page=30")
    approved=select_approval(response.get("workflow_runs",[]),sha,last_id,now or datetime.now(timezone.utc))
    if not approved:return "STAGING_NO_NEW_APPROVAL"
    if not checks_pass(get("/commits/"+sha+"/check-runs?per_page=100").get("check_runs",[]),sha):
        return "STAGING_CI_GATE_BLOCKED"
    deploy=repo/"scripts/deploy_pm2_stage.sh"
    if not deploy.is_file() or deploy.is_symlink():
        return "STAGING_DEPLOY_SCRIPT_MISSING"
    consume(state,approved["id"],sha) # consume BEFORE executing; no automatic retries.
    r=execute(["bash",str(deploy),sha],cwd=str(repo),check=False,timeout=900)
    if r.returncode:
        raise RuntimeError("Staging deploy failed; NEW manual approval required")
    return "STAGING_DEPLOY_PASS sha="+sha

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--apply",action="store_true")
    args=p.parse_args()
    try: print(poll(Path.home(),apply=args.apply))
    except Exception as e:
        print("STAGING_AGENT_FAILED "+type(e).__name__+": "+str(e),file=sys.stderr)
        return 1
    return 0

if __name__=="__main__":sys.exit(main())
