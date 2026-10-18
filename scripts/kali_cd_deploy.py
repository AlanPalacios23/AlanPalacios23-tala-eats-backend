#!/usr/bin/env python3
"""GitHub Actions -> constrained SSH -> Kali Backend/Worker ONLY.

Fail closed: requires root-owned, expiring operations approval after an actual
off-host backup and isolated restore drill. No financial transactions, secret
output, migrations, DB restore, volume manipulation or live env edits.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone, timedelta
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen

REPO = Path.home() / "tala-backend-audit"
WORKTREES = Path.home() / "talaeats-cd-sources"
STATE = Path.home() / ".local/share/talaeats/cd"
PROJECT = "talaeats-v3"
LIVE = Path.home() / "talaeats-releases/TalaEats-Web-v1.6.4-CONNECT-SELF-SERVICE-HF1-LIVE"
COMPOSE = LIVE / "docker-compose.cloudflare.yml"
APPROVAL = Path("/etc/talaeats/cd-approval.json")
BACKUP = Path.home() / "talaeats-backups/20261018T042833Z-encrypted.VkjIWd6q"
READY = "http://127.0.0.1:8082/api/v1/ready"
SCHEMA = "f21i00000001"
SERVICES = ("backend", "worker")
HEALTHY = ("backend", "db", "redis")
PROTECTED = ("db", "redis", "frontend", "caddy")


class ReleaseBlocked(Exception):
    pass


def cmd(*args, timeout=90, cwd=None):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                           check=False, cwd=cwd)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ReleaseBlocked("No disponible el comando aprobado: " + args[0]) from exc
    if p.returncode:
        # Never display subprocess stderr: Docker/Compose may include credentials.
        raise ReleaseBlocked("Fallo de operación: " + args[0] + " " + args[1])
    return p.stdout.strip()


def docker(*args, timeout=90):
    return cmd("docker", *args, timeout=timeout)


def inspect(service):
    raw = docker("inspect", "--type=container", "--format={{json .}}",
                 f"{PROJECT}-{service}-1")
    return json.loads(raw)


def image_id(tag):
    return docker("image", "inspect", "--format={{.Id}}", tag)


def sha256(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(part)
    return h.hexdigest()


def valid_sha(value):
    if not re.fullmatch(r"[0-9a-f]{40}", value):
        raise ReleaseBlocked("SHA Git inválido")
    return value


def checkout_sha(sha):
    if not (REPO / ".git").exists() or not COMPOSE.is_file():
        raise ReleaseBlocked("Falta checkout o Compose LIVE verificado")
    cmd("git", "-C", str(REPO), "fetch", "--quiet", "--no-tags",
        "origin", "refs/heads/main:refs/remotes/origin/main", timeout=90)
    main = cmd("git", "-C", str(REPO), "rev-parse", "refs/remotes/origin/main")
    if main != sha:
        raise ReleaseBlocked("Commit ya no es HEAD de origin/main")
    if cmd("git", "-C", str(REPO), "status", "--porcelain", "--", "backend"):
        raise ReleaseBlocked("El checkout base tiene cambios locales")
    WORKTREES.mkdir(parents=True, mode=0o700, exist_ok=True)
    tree = WORKTREES / sha
    if not tree.is_dir():
        cmd("git", "-C", str(REPO), "worktree", "add", "--detach", str(tree), sha,
            timeout=90)
    if cmd("git", "-C", str(tree), "rev-parse", "HEAD") != sha or \
            cmd("git", "-C", str(tree), "status", "--porcelain", "--", "backend"):
        raise ReleaseBlocked("Fuentes no equivalen al SHA de GitHub")
    return tree


def verify_backup():
    if not BACKUP.is_dir() or BACKUP.is_symlink():
        raise ReleaseBlocked("Falta respaldo cifrado local")
    manifest = BACKUP / "SHA256SUMS.txt"
    if not manifest.is_file() or manifest.is_symlink():
        raise ReleaseBlocked("Manifiesto SHA256 ausente")
    found = set()
    for line in manifest.read_text(encoding="utf-8").splitlines():
        m = re.fullmatch(r"([0-9a-f]{64})  (postgresql\.dump\.gpg|media\.tar\.gpg)", line)
        if not m:
            raise ReleaseBlocked("Manifiesto SHA256 inválido")
        expected, name = m.groups()
        file = BACKUP / name
        if not file.is_file() or file.is_symlink() or sha256(file) != expected:
            raise ReleaseBlocked("Respaldo alterado o no disponible: " + name)
        found.add(name)
    if found != {"postgresql.dump.gpg", "media.tar.gpg"}:
        raise ReleaseBlocked("El respaldo está incompleto")


def approval():
    # Installed by an operator as root after a REAL offsite verification and
    # PostgreSQL 16+media restore drill. GitHub must never create this marker.
    if not APPROVAL.is_file() or APPROVAL.is_symlink():
        raise ReleaseBlocked("NO-GO: falta aprobación local de recuperación")
    st = APPROVAL.stat()
    if st.st_uid != 0 or st.st_mode & 0o022:
        raise ReleaseBlocked("NO-GO: la aprobación debe pertenecer a root")
    data = json.loads(APPROVAL.read_text(encoding="utf-8"))
    if any(data.get(k) is not True for k in (
        "allow_automatic_production", "offsite_backup_verified",
        "isolated_restore_test_pass", "automated_backup_policy_verified"
    )):
        raise ReleaseBlocked("NO-GO: faltan respaldos o ensayos reales")
    if data.get("branch") != "main":
        raise ReleaseBlocked("NO-GO: rama Git inesperada")
    try:
        expires = datetime.fromisoformat(data["expires_utc"].replace("Z", "+00:00"))
    except (KeyError, ValueError, TypeError) as exc:
        raise ReleaseBlocked("NO-GO: caducidad de autorización inválida") from exc
    if expires.tzinfo is None or expires <= datetime.now(timezone.utc):
        raise ReleaseBlocked("NO-GO: autorización de operaciones caducada")
    if expires > datetime.now(timezone.utc) + timedelta(days=30):
        raise ReleaseBlocked("NO-GO: autorización excede 30 días")


def runtime_snapshot():
    ids = {}
    for service in (*SERVICES, *PROTECTED):
        d = inspect(service)
        conf = d.get("Config") or {}
        labels = conf.get("Labels") or {}
        if labels.get("com.docker.compose.project") != PROJECT or \
           labels.get("com.docker.compose.service") != service:
            raise ReleaseBlocked("Identidad Compose inesperada: " + service)
        state = d.get("State") or {}
        if not state.get("Running") or (service in HEALTHY and
                 (state.get("Health") or {}).get("Status") != "healthy"):
            raise ReleaseBlocked("Contenedor fuera de servicio: " + service)
        ids[service] = d["Image"]
        if service == "backend":
            env = {}
            for item in conf.get("Env", []):
                if "=" in item:
                    key, value = item.split("=", 1)
                    if key in ("ENVIRONMENT", "AUTO_MIGRATE_ON_START",
                               "UVICORN_FORWARDED_ALLOW_IPS",
                               "WITHDRAWALS_LIVE_ENABLED", "WITHDRAWALS_EXECUTION_ENABLED"):
                        env[key] = value.strip().lower()
            if env.get("ENVIRONMENT") != "production":
                raise ReleaseBlocked("ENVIRONMENT no es production")
            if env.get("AUTO_MIGRATE_ON_START", "false") in ("true", "1", "on", "yes"):
                raise ReleaseBlocked("Auto migración de arranque prohibida")
            if env.get("UVICORN_FORWARDED_ALLOW_IPS") == "*":
                raise ReleaseBlocked("Proxy wildcard no autorizado")
            if env.get("WITHDRAWALS_LIVE_ENABLED") in ("true", "1", "yes") or \
               env.get("WITHDRAWALS_EXECUTION_ENABLED") in ("true", "1", "yes"):
                raise ReleaseBlocked("Payouts LIVE activos: requiere despliegue manual")
    try:
        with urlopen(READY, timeout=8) as res:
            health = json.loads(res.read(16384))
        if health.get("ready") is not True or health.get("database") is not True or health.get("redis") is not True:
            raise ReleaseBlocked("API LIVE no está lista para rollout")
    except (OSError, ValueError, TimeoutError) as exc:
        raise ReleaseBlocked("No se pudo verificar readiness LIVE") from exc
    current = docker("exec", "-w", "/app", f"{PROJECT}-backend-1", "alembic", "current")
    if current.strip() != SCHEMA + " (head)":
        raise ReleaseBlocked("Alembic del servidor no coincide")
    return ids


def candidate_head(tree):
    # The new image may not introduce a schema change: migration is manual.
    lines = list((tree / "backend/migrations/versions").glob("*.py"))
    revisions, previous = set(), set()
    for f in lines:
        content = f.read_text(encoding="utf-8")
        revision = re.search(r"(?m)^revision\s*=\s*['\"]([^'\"]+)['\"]", content)
        down = re.search(r"(?m)^down_revision\s*=\s*['\"]([^'\"]+)['\"]", content)
        if revision:
            revisions.add(revision.group(1))
        if down:
            previous.add(down.group(1))
    if (revisions - previous) != {SCHEMA}:
        raise ReleaseBlocked("Nuevas migraciones detectadas: AUTO-CD prohibido")


def build_candidate(tree, sha):
    tag = "talaeats-cd:" + sha
    print("Compilando imagen inmutable:", sha[:12], flush=True)
    docker("build", "--pull", "--label", "org.opencontainers.image.revision=" + sha,
           "--tag", tag, str(tree / "backend"), timeout=2400)
    if docker("image", "inspect", "--format={{.Config.User}}", tag) != "talaeats":
        raise ReleaseBlocked("La imagen requiere usuario sin privilegios")
    docker("run", "--rm", "--network", "none", "--entrypoint", "python",
           tag, "-c", "import app.main; from app.config import settings;"
                      "assert settings.app_version", timeout=150)
    return tag


def compose(overlay, *args, timeout=180):
    return cmd("docker", "compose", "-p", PROJECT,
               "--project-directory", str(LIVE),
               "-f", str(COMPOSE), "-f", str(overlay), *args, timeout=timeout)


def overlay_file(dir_, backend, worker):
    dir_.mkdir(parents=True, exist_ok=True)
    path = dir_ / "override.yml"
    path.write_text(
        "services:\n  backend:\n    image: " + backend +
        "\n  worker:\n    image: " + worker + "\n", encoding="utf-8")
    data = json.loads(compose(path, "config", "--format", "json"))
    svcs = data.get("services") or {}
    if data.get("name") not in (None, PROJECT):
        raise ReleaseBlocked("Compose cambió de proyecto")
    if svcs.get("backend", {}).get("image") != backend or \
       svcs.get("worker", {}).get("image") != worker or \
       any(service not in svcs for service in PROTECTED):
        raise ReleaseBlocked("Compose modificó servicios protegidos")
    # Do not log the resolved config: it can contain production secrets.
    return path


def readiness(expected_image):
    deadline = time.monotonic() + 110
    while time.monotonic() < deadline:
        try:
            api = inspect("backend")
            worker = inspect("worker")
            if api["Image"] != expected_image or worker["Image"] != expected_image:
                time.sleep(3)
                continue
            if (api.get("State") or {}).get("Health", {}).get("Status") != "healthy" or \
               not (worker.get("State") or {}).get("Running"):
                time.sleep(3)
                continue
            with urlopen(READY, timeout=5) as response:
                health = json.loads(response.read(16384))
            if health.get("ready") is True and health.get("database") is True and \
               health.get("redis") is True:
                return
        except (ValueError, OSError, TimeoutError, KeyError):
            pass
        time.sleep(3)
    raise ReleaseBlocked("La nueva imagen no alcanzó readiness")


def deploy(sha, dry_run=False):
    valid_sha(sha)
    # Complete fail-closed gates before modifying any LIVE container.
    approval()
    verify_backup()
    original = runtime_snapshot()
    tree = checkout_sha(sha)
    candidate_head(tree)
    if dry_run:
        print("TALA_CD_PREFLIGHT_PASS: recovery/CI source/runtime guards; no deploy")
        return
    image = build_candidate(tree, sha)
    # Tag previous image by runtime Image ID so rollback never depends on
    # mutable compose tags. No DB/Redis/media volumes are touched.
    tags = {}
    for service in SERVICES:
        tag = f"talaeats-cd-rollback/{service}:{sha[:12]}"
        docker("image", "tag", original[service], tag)
        if image_id(tag) != original[service]:
            raise ReleaseBlocked("No se pudo conservar imagen " + service)
        tags[service] = tag

    with tempfile.TemporaryDirectory(prefix="talaeats-cd-") as td:
        folder = Path(td)
        change = overlay_file(folder, image, image)
        restore = overlay_file(folder / "restore", tags["backend"], tags["worker"])
        # The rollback overlay is kept under the same isolated directory.
        try:
            compose(change, "up", "--no-deps", "--no-build", "-d", "backend", "worker")
            readiness(image_id(image))
            for protected in PROTECTED:
                if inspect(protected)["Image"] != original[protected]:
                    raise ReleaseBlocked("Servicio ajeno al rollout modificado")
        except Exception:
            print("TALA_CD_HEALTH_FAILED: intentando restaurar SOLO backend/worker")
            try:
                compose(restore, "up", "--no-deps", "--no-build", "-d", "backend", "worker")
                # Worker and Backend may have different old image IDs.
                stop = time.monotonic() + 110
                while time.monotonic() < stop:
                    if inspect("backend")["Image"] == original["backend"] and \
                       inspect("worker")["Image"] == original["worker"]:
                        break
                    time.sleep(3)
                else:
                    raise ReleaseBlocked("Rollback no llegó a imágenes anteriores")
                print("TALA_CD_ROLLBACK_IMAGES_RESTORED: verificar salud y finanzas")
            except Exception:
                print("CRITICAL_ROLLBACK_NEEDS_OPERATOR")
            raise
    print("TALA_CD_DEPLOY_PASS:", sha)


def self_test():
    assert valid_sha("a" * 40)
    for invalid in ("", "main", "a" * 39, "-f", "a" * 40 + ";rm"):
        try:
            valid_sha(invalid)
        except ReleaseBlocked:
            pass
        else:
            raise AssertionError("SHA inseguro permitido")
    print("TALA_CD_STATIC_GUARDS_PASS")


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--self-test", action="store_true")
    group.add_argument("--check", metavar="SHA")
    group.add_argument("--deploy", metavar="SHA")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (STATE / "cd.lock").open("a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            deploy(args.check or args.deploy, dry_run=bool(args.check))
        except (ReleaseBlocked, OSError, ValueError, KeyError,
                subprocess.SubprocessError) as exc:
            print("TALA_CD_BLOCKED:", str(exc), file=sys.stderr)
            sys.exit(2)


if __name__ == "__main__":
    main()
