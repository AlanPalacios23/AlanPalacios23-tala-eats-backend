#!/usr/bin/env python3
"""TALA EATS: isolated, networkless V3 PostgreSQL dump restore test.

Uses a NEW short-lived PostgreSQL container created from the EXISTING cached
V3 database image. --network none, no port mapping, no bind mounts, PGDATA
on tmpfs. Restores an existing 0600 backup ONLY in that disposable container.
Never accesses live DB data, invokes any production Compose changes, or
prints DB records, credentials, logs, dump contents or exception messages.

Only the newly created, labeled container is removed, even on failure.
Does not replace a full rehearsal of application/database recovery procedures.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import time

ROOT=Path.home()/".local/share/talaeats/v3-recovery-private/backups"
DUMP=ROOT/"v3-pre-recovery-20261019T023723Z.dump"
LIVE_DB="talaeats-v3-db-1"
LABEL="talaeats.v3.isolated_restore_test"
LABEL_VALUE="yes"

def process(args, *, timeout=25, stream=None):
    return subprocess.run(args,stdin=stream,stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE,check=False,timeout=timeout)

def docker_inspect(container,template):
    result=process(["docker","inspect","--type","container","--format",template,container])
    if result.returncode!=0:raise RuntimeError("Docker metadata unavailable")
    return json.loads(result.stdout)

def private_backup(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size<1024:
        return False
    if stat.S_IMODE(path.stat().st_mode)&0o077:
        return False
    if path.parent.is_symlink() or not path.parent.is_dir():
        return False
    if stat.S_IMODE(path.parent.stat().st_mode)&0o077:
        return False
    return True

def test_image_ready(image):
    if not isinstance(image,str) or not re.fullmatch(r"sha256:[a-f0-9]{64}",image):
        return False
    result=process(["docker","image","inspect","--format","{{.Id}}",image])
    return result.returncode==0 and result.stdout.decode("ascii","ignore").strip()==image

def scratch_safe(container_id):
    labels=docker_inspect(container_id,"{{json .Config.Labels}}")
    host=docker_inspect(container_id,"{{json .HostConfig}}")
    mounts=docker_inspect(container_id,"{{json .Mounts}}")
    return (labels.get(LABEL)==LABEL_VALUE
            and labels.get("com.docker.compose.project") is None
            and host.get("NetworkMode")=="none"
            and not host.get("PortBindings")
            and not host.get("Binds")
            and all(m.get("Type")=="tmpfs" for m in mounts))

def recover():
    print("TALA_V3_ISOLATED_RESTORE_BEGIN")
    container_id=None
    restore_pass=False
    try:
        if not private_backup(DUMP):
            print("PROTECTED_BACKUP_PRESENT no")
            return
        print("PROTECTED_BACKUP_PRESENT yes")
        labels=docker_inspect(LIVE_DB,"{{json .Config.Labels}}")
        if labels.get("com.docker.compose.project")!="talaeats-v3" or labels.get("com.docker.compose.service")!="db":
            print("SOURCE_DB_IDENTITY_REJECTED")
            return
        print("SOURCE_DB_IDENTITY yes")
        image=docker_inspect(LIVE_DB,"{{json .Image}}")
        if not test_image_ready(image):
            print("SOURCE_IMAGE_IN_CACHE no")
            return
        print("SOURCE_IMAGE_IN_CACHE yes")

        name="tala-v3-restore-test-"+secrets.token_hex(7)
        args=["docker","run","--rm","--detach",
              "--name",name,
              "--label",LABEL+"="+LABEL_VALUE,
              "--network","none",
              "--memory","768m",
              "--cpus","0.75",
              "--pids-limit","160",
              "--tmpfs","/var/lib/postgresql/data:rw,size=512m",
              "--tmpfs","/var/run/postgresql:rw,size=16m",
              "--tmpfs","/tmp:rw,size=64m",
              "-e","POSTGRES_HOST_AUTH_METHOD=trust",
              "-e","POSTGRES_USER=postgres",
              "-e","POSTGRES_DB=postgres",
              "-e","PGDATA=/var/lib/postgresql/data/pgdata",
              image]
        started=process(args,timeout=30)
        if started.returncode:
            print("SCRATCH_CONTAINER_START fail")
            return
        candidate=started.stdout.decode("ascii","ignore").strip()
        if not re.fullmatch(r"[a-f0-9]{64}",candidate):
            print("SCRATCH_CONTAINER_ID_INVALID")
            return
        container_id=candidate
        if not scratch_safe(container_id):
            print("SCRATCH_ISOLATION_CHECK fail")
            return
        print("SCRATCH_ISOLATION_CHECK pass")
        for _ in range(35):
            p=process(["docker","exec",container_id,
                       "pg_isready","-q","-U","postgres","-d","postgres"],timeout=6)
            if p.returncode==0:break
            time.sleep(1)
        else:
            print("SCRATCH_POSTGRES_READY fail")
            return
        print("SCRATCH_POSTGRES_READY pass")
        with DUMP.open("rb") as backup:
            p=process(["docker","exec","-i",container_id,
                       "pg_restore","--exit-on-error","--single-transaction",
                       "--no-owner","--no-acl","-U","postgres","-d","postgres"],
                      timeout=240,stream=backup)
        if p.returncode:
            print("FULL_RESTORE fail")
            return
        print("FULL_RESTORE pass")
        q=process(["docker","exec",container_id,"psql",
                  "-X","-q","-t","-A","-v","ON_ERROR_STOP=1",
                  "-U","postgres","-d","postgres",
                  "-c","SELECT count(*) FROM pg_catalog.pg_class c JOIN "
                        "pg_catalog.pg_namespace n ON n.oid=c.relnamespace "
                        "WHERE n.nspname NOT IN ('pg_catalog','information_schema') "
                        "AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p')"],
                  timeout=20)
        value=q.stdout.decode("ascii","ignore").strip()
        if q.returncode or not value.isdecimal() or int(value)<1:
            print("RESTORED_TABLES_VALIDATED fail")
            return
        print("RESTORED_TABLES_VALIDATED pass")
        print("RESTORED_TABLE_COUNT",int(value))
        restore_pass=True
    except (OSError,ValueError,RuntimeError,TypeError,subprocess.TimeoutExpired):
        print("RESTORE_TEST_UNAVAILABLE")
    finally:
        if container_id:
            try:
                if scratch_safe(container_id):
                    gone=process(["docker","rm","-f",container_id],timeout=35)
                    print("SCRATCH_CONTAINER_CLEANED","yes" if gone.returncode==0 else "no")
                else:
                    print("SCRATCH_CONTAINER_CLEANED check-needed")
            except (OSError,RuntimeError,subprocess.TimeoutExpired):
                print("SCRATCH_CONTAINER_CLEANED check-needed")
        print("ISOLATED_RESTORE_TEST", "PASS" if restore_pass else "FAIL")
        print("NO_PRODUCTION_CHANGES_NO_SECRET_OR_TABLE_CONTENT_OUTPUT")
        print("TALA_V3_ISOLATED_RESTORE_END")

if __name__=="__main__":
    recover()
