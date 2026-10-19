#!/usr/bin/env python3
"""TALA EATS green-only GitHub SSH CD. No v3, no db migration or payment operations."""
from __future__ import annotations
import argparse
from datetime import datetime, timedelta, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen

PROJECT = "talaeats-green"
ROOT = Path("/home/alan/talaeats-green-20261018")
COMPOSE = ROOT / "compose.yml"
ENV = ROOT / "green.env"
REPO = Path("/home/alan/tala-backend-audit")
STATE = Path("/home/alan/.local/share/talaeats/green-cd")
TREES = Path("/home/alan/talaeats-green-cd-sources")
APPROVAL = Path("/etc/talaeats/green-cd-approval.json")
BACKUP_PROOF = Path("/etc/talaeats/green-cd-backup-proof.json")
READY = "http://127.0.0.1:18182/api/v1/ready"
SCHEMA = "f21i00000001"
VERSION = "1.6.4-connect-selfservice-hf1"
SHA_PATTERN = re.compile(r"[a-f0-9]{40}\Z")


class Blocked(Exception):
    pass


def call(*args, timeout=120, cwd=None):
    try:
        res = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, timeout=timeout, cwd=cwd, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Blocked("No se pudo ejecutar " + args[0]) from exc
    if res.returncode:
        # No echo of Docker or Git output: may contain credentials.
        raise Blocked("Comando falló: " + " ".join(args[:2]) +
                      " (salida no mostrada por seguridad)")
    return res.stdout.strip()


def docker(*args, timeout=120):
    return call("docker", *args, timeout=timeout)


def compose(overlay, *action, timeout=200):
    cmd = ["docker", "compose", "-p", PROJECT,
           "--project-directory", str(ROOT),
           "--env-file", str(ENV), "-f", str(COMPOSE)]
    if overlay is not None:
        cmd += ["-f", str(overlay)]
    return call(*cmd, *action, timeout=timeout)


def inspect(name):
    return json.loads(docker("inspect", "--type=container", "--format={{json .}}",
                             f"{PROJECT}-{name}-1"))


def image_id(tag):
    return docker("image", "inspect", "--format={{.Id}}", tag)


def valid_sha(sha):
    if not SHA_PATTERN.fullmatch(sha):
        raise Blocked("SHA debe tener 40 caracteres hexadecimales")
    return sha


def get_approval_file(path):
    if not path.is_file() or path.is_symlink():
        raise Blocked("Falta aprobación local de operaciones/backup: " + path.name)
    st = path.stat()
    parent = path.parent.stat()
    if st.st_uid != 0 or st.st_mode & 0o022 or parent.st_uid != 0 or parent.st_mode & 0o022:
        raise Blocked("Autorización modificable por no-root: " + path.name)
    return json.loads(path.read_text(encoding="utf-8"))


def approval():
    data = get_approval_file(APPROVAL)
    for flag in ("auto_cd_approved", "restore_drill_verified", "offsite_backup_verified",
                 "green_automatic_backup_verified"):
        if data.get(flag) is not True:
            raise Blocked("Aprobación pendiente: " + flag)
    if data.get("project") != PROJECT or data.get("branch") != "main":
        raise Blocked("Proyecto o rama de aprobación incorrecta")
    try:
        until = datetime.fromisoformat(data["expires_utc"].replace("Z", "+00:00"))
    except (KeyError, ValueError, TypeError) as exc:
        raise Blocked("Caducidad de aprobación inválida") from exc
    now = datetime.now(timezone.utc)
    if until.tzinfo is None or not (now < until <= now + timedelta(days=30)):
        raise Blocked("Aprobación caducada o demasiado extensa")
    # Require an independently updated root-owned proof of a recent green backup
    # which has been copied offsite and tested. No static one-time marker.
    proof = get_approval_file(BACKUP_PROOF)
    if proof.get("project") != PROJECT or proof.get("offsite_sha256_verified") is not True:
        raise Blocked("Sin prueba del backup green externo")
    try:
        at = datetime.fromisoformat(proof["verified_at_utc"].replace("Z", "+00:00"))
    except (KeyError, ValueError, TypeError) as exc:
        raise Blocked("Fecha del backup inválida") from exc
    if at.tzinfo is None or not timedelta() <= now - at <= timedelta(hours=24):
        raise Blocked("No hay copia green externa verificada en últimas 24 horas")


def ensure_current():
    if not COMPOSE.is_file() or not ENV.is_file() or COMPOSE.is_symlink() or ENV.is_symlink():
        raise Blocked("No existe Compose green original")
    # Read local runtime settings only to enforce zero demo / disabled money movement.
    parsed = dict(line.split("=", 1) for line in ENV.read_text().splitlines()
                  if "=" in line)
    expected = {"ENVIRONMENT": "production", "SEED_DEMO_DATA": "false",
                "BOOTSTRAP_ADMIN_ENABLED": "false",
                "AUTO_MIGRATE_ON_START": "false", "STRIPE_ENABLED": "false",
                "WITHDRAWALS_EXECUTION_ENABLED": "false",
                "WITHDRAWALS_LIVE_ENABLED": "false"}
    if any(parsed.get(k) != v for k, v in expected.items()):
        raise Blocked("Configuración green no autoriza CD/no-demo")
    current = {}
    for svc in ("api", "worker", "db", "redis"):
        obj = inspect(svc)
        labels = (obj.get("Config") or {}).get("Labels") or {}
        state = obj.get("State") or {}
        if (labels.get("com.docker.compose.project") != PROJECT or
            labels.get("com.docker.compose.service") != svc or not state.get("Running")):
            raise Blocked("Contenedor green no operativo: " + svc)
        if svc in ("api", "db", "redis") and (state.get("Health") or {}).get("Status") != "healthy":
            raise Blocked("Contenedor green no saludable: " + svc)
        current[svc] = obj["Image"]
    with urlopen(READY, timeout=8) as response:
        status = json.load(response)
    if (status.get("ready") is not True or status.get("database") is not True or
        status.get("redis") is not True):
        raise Blocked("Green no respondió ready=true")
    current_schema = docker("exec", f"{PROJECT}-db-1", "psql", "-X", "-qAt",
                            "-U", "tala_green", "-d", "tala_green",
                            "-c", "SELECT version_num FROM alembic_version")
    if current_schema != SCHEMA:
        raise Blocked("Alembic distinto al esquema aprobado: actualización manual requerida")
    return current


def checkout(sha):
    if not (REPO / ".git").exists():
        raise Blocked("No hay checkout GitHub en Kali")
    call("git", "-C", str(REPO), "fetch", "--quiet", "origin",
         "refs/heads/main:refs/remotes/origin/main", timeout=120)
    head = call("git", "-C", str(REPO), "rev-parse", "refs/remotes/origin/main")
    if head != sha:
        raise Blocked("SHA obsoleto, ya no es HEAD main")
    TREES.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = TREES / sha
    if not target.exists():
        call("git", "-C", str(REPO), "worktree", "add",
             "--detach", str(target), sha, timeout=120)
    if (call("git", "-C", str(target), "rev-parse", "HEAD") != sha or
        call("git", "-C", str(target), "status", "--porcelain", "--", "backend")):
        raise Blocked("Worktree no coincide con commit SHA")
    return target


def schema_check(tree):
    # Only code changes at existing schema head may auto-deploy.
    import ast
    revs, parents = set(), set()
    for file in (tree / "backend/migrations/versions").glob("*.py"):
        t = ast.parse(file.read_text(encoding="utf-8"))
        values = {}
        for node in t.body:
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id in ("revision", "down_revision"):
                        values[target.id] = ast.literal_eval(node.value)
        rev = values.get("revision")
        if not isinstance(rev, str):
            raise Blocked("Migración con revisión ilegible")
        revs.add(rev)
        p = values.get("down_revision")
        if isinstance(p, str):
            parents.add(p)
        elif isinstance(p, (tuple, list)):
            parents.update(p)
    if revs - parents != {SCHEMA}:
        raise Blocked("Hay migraciones nuevas: requiere despliegue supervisado")


def image_build(tree, sha):
    tag = "talaeats-green-cd:" + sha
    print("BUILD_GREEN_SHA " + sha[:12], flush=True)
    docker("build", "--pull", "--label", "org.opencontainers.image.revision="+sha,
           "-t", tag, str(tree / "backend"), timeout=2400)
    if (docker("image", "inspect", "--format={{.Config.User}}", tag) != "talaeats" or
        docker("image", "inspect",
               '--format={{index .Config.Labels "org.opencontainers.image.revision"}}', tag) != sha):
        raise Blocked("Imagen nueva no tiene non-root / revisión requerida")
    docker("run", "--rm", "--network", "none", "--entrypoint", "python",
           tag, "-c", "import app.main; from app.config import settings; "
                      "assert settings.app_version", timeout=140)
    return tag


def overlay(folder, tag):
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    filename = folder / "images.yml"
    filename.write_text("services:\n  api:\n    image: "+tag+"\n"
                        "  worker:\n    image: "+tag+"\n", encoding="utf-8")
    config = json.loads(compose(filename, "config", "--format", "json"))
    if config.get("name") != PROJECT:
        raise Blocked("Compose del proyecto incorrecto")
    svcs = config.get("services") or {}
    if (svcs.get("api", {}).get("image") != tag or
        svcs.get("worker", {}).get("image") != tag or
        any(x not in svcs for x in ("db", "redis")) or
        svcs["db"].get("image") != "postgres:16-alpine" or
        svcs["redis"].get("image") != "redis:8-alpine"):
        raise Blocked("Override Compose inseguro")
    api_ports = svcs["api"].get("ports") or []
    if (len(api_ports) != 1 or api_ports[0].get("host_ip") != "127.0.0.1" or
        str(api_ports[0].get("published")) != "18182"):
        raise Blocked("Puerto API green no restringido a loopback")
    return filename


def wait_for_images(expected, timeout=150):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            api, worker = inspect("api"), inspect("worker")
            if (api["Image"] == expected and worker["Image"] == expected and
                (api["State"].get("Health") or {}).get("Status") == "healthy" and
                worker["State"].get("Running")):
                with urlopen(READY, timeout=4) as response:
                    health = json.load(response)
                if health.get("ready") is True and health.get("database") is True and health.get("redis") is True:
                    return
        except (OSError, ValueError, KeyError, TimeoutError):
            pass
        time.sleep(3)
    raise Blocked("API/Worker no quedaron sanos tras el cambio")


def deploy(sha, dry_run):
    valid_sha(sha)
    current = ensure_current()
    tree = checkout(sha)
    schema_check(tree)
    if dry_run:
        print("GREEN_CD_PREFLIGHT_PASS sha=" + sha[:12])
        return
    approval()    # Deliberately AFTER non-mutating validation, BEFORE any image changes
    tag = image_build(tree, sha)
    previous_id = current["api"]
    if previous_id != current["worker"]:
        raise Blocked("Backend y worker previos tienen imágenes distintas: revisión manual")
    rollback = "talaeats-green-cd-rollback:" + sha[:12]
    docker("image", "tag", previous_id, rollback)
    if image_id(rollback) != previous_id:
        raise Blocked("No se pudo fijar la imagen de rollback")
    with tempfile.TemporaryDirectory(prefix="tala-green-cd-") as tmp:
        new = overlay(Path(tmp)/"new", tag)
        old = overlay(Path(tmp)/"old", rollback)
        try:
            compose(new, "up", "-d", "--no-deps", "--no-build", "api", "worker")
            wait_for_images(image_id(tag))
            for svc in ("db", "redis"):
                if inspect(svc)["Image"] != current[svc]:
                    raise Blocked("Dependencia protegida ha cambiado: " + svc)
        except Exception:
            print("GREEN_CD_FAILED_ROLLING_BACK", flush=True)
            try:
                compose(old, "up", "-d", "--no-deps", "--no-build", "api", "worker")
                wait_for_images(previous_id)
                print("GREEN_CD_ROLLBACK_PASS", flush=True)
            except Exception:
                print("GREEN_CD_ROLLBACK_CRITICAL_CHECK_KALI", flush=True)
            raise
    print("GREEN_CD_DEPLOY_PASS sha=" + sha, flush=True)


def self_test():
    assert valid_sha("a" * 40)
    assert PROJECT == "talaeats-green"
    assert ROOT.name == "talaeats-green-20261018"
    for value in ("", "main", "a" * 39, "a" * 40 + ";exit"):
        try:
            valid_sha(value)
        except Blocked:
            continue
        raise AssertionError("Insecure SHA allowed")
    print("GREEN_CD_ENGINE_PROBE_PASS — sin tocar contenedores")


def main():
    parser = argparse.ArgumentParser()
    g = parser.add_mutually_exclusive_group(required=True)
    g.add_argument("--probe", action="store_true")
    g.add_argument("--preflight")
    g.add_argument("--deploy")
    args = parser.parse_args()
    if args.probe:
        self_test()
        return
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (STATE / "cd.lock").open("a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            deploy(args.preflight or args.deploy, bool(args.preflight))
        except (Blocked, OSError, ValueError, TypeError, KeyError,
                subprocess.SubprocessError) as exc:
            print("GREEN_CD_BLOCKED: " + str(exc), file=sys.stderr)
            sys.exit(2)


if __name__ == "__main__":
    main()
