#!/usr/bin/env python3
"""Guarded, human-operated GitHub -> Kali candidate build and promotion.

NO deploy on --prepare; --apply requires proven off-host recovery and explicit
SHA confirmation. No GitHub runner, passwords, .env, financial API requests,
Alembic upgrades, volume deletion or migrations are performed here.
"""
from __future__ import annotations

import argparse
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
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

REPO = Path.home() / "tala-backend-audit"
SHA = "d584e2dcad91c46b2dfa2834343d5f7562486bca"
VERSION = "1.6.4-connect-selfservice-hf1"
PROJECT = "talaeats-v3"
LIVE = Path.home() / "talaeats-releases/TalaEats-Web-v1.6.4-CONNECT-SELF-SERVICE-HF1-LIVE"
COMPOSE = LIVE / "docker-compose.cloudflare.yml"
BACKUP = Path.home() / "talaeats-backups/20261018T042833Z-encrypted.VkjIWd6q"
IMAGE = "talaeats-candidate:" + SHA
ROLLBACK = {
    "backend": (
        "sha256:3b1d89ec510d6768eacd27122a32e3bf0feffbe4a7937911f0f4defeda062360",
        "talaeats-rollback/backend:v1.6.4-hf1-e22e4d5",
    ),
    "worker": (
        "sha256:624d02c855ec2d712f48d81ff32ab4019c78762e02e91a55bd59a2fa5d96246a",
        "talaeats-rollback/worker:v1.6.4-hf1-e22e4d5",
    ),
}
READY = "http://127.0.0.1:8082/api/v1/ready"
STATE = Path.home() / ".local/share/talaeats/production-deploy"
MANIFEST = STATE / ("candidate-" + SHA + ".json")


class GateError(Exception):
    pass


def run(*args: str, cwd: Path | None = None, timeout: int = 90) -> str:
    try:
        p = subprocess.run(args, cwd=cwd, capture_output=True,
                           text=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GateError("No fue posible completar el comando autorizado: " + args[0]) from exc
    if p.returncode:
        # The tool could include secrets in stderr. NEVER include stdout/stderr.
        raise GateError("Falló una operación: " + " ".join(args[:2]))
    return p.stdout.strip()


def docker(*args: str, timeout: int = 90) -> str:
    return run("docker", *args, timeout=timeout)


def git(*args: str) -> str:
    return run("git", "-C", str(REPO), *args)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def check_git_and_backup() -> None:
    if not REPO.is_dir() or not (REPO / "backend/Dockerfile").is_file():
        raise GateError("Falta checkout limpio ~/tala-backend-audit")
    if git("rev-parse", "HEAD") != SHA:
        raise GateError("Git HEAD inesperado: exigir main@" + SHA[:12])
    if git("status", "--porcelain", "--", "backend"):
        raise GateError("El código backend tiene cambios locales")
    if not COMPOSE.is_file() or COMPOSE.is_symlink():
        raise GateError("Compose LIVE no coincide con la ubicación documentada")
    if not BACKUP.is_dir() or BACKUP.is_symlink():
        raise GateError("Falta respaldo cifrado del 18/oct")
    manifest = BACKUP / "SHA256SUMS.txt"
    if not manifest.is_file() or manifest.is_symlink():
        raise GateError("Falta manifiesto SHA256")
    names = set()
    for line in manifest.read_text(encoding="utf-8").splitlines():
        m = re.fullmatch(r"([0-9a-f]{64})  (postgresql\.dump\.gpg|media\.tar\.gpg)", line)
        if not m:
            raise GateError("SHA256SUMS.txt contiene líneas inesperadas")
        expected, name = m.groups()
        f = BACKUP / name
        if not f.is_file() or f.is_symlink() or f.stat().st_size < 100:
            raise GateError("Falta archivo cifrado seguro: " + name)
        if sha256(f) != expected:
            raise GateError("Backup SHA256 incorrecto: " + name)
        names.add(name)
    if names != {"postgresql.dump.gpg", "media.tar.gpg"}:
        raise GateError("Respaldo incompleto")


def inspect(name: str) -> dict:
    raw = docker("inspect", "--type=container", "--format={{json .}}", name)
    try:
        return json.loads(raw)
    except ValueError as exc:
        raise GateError("No se pudo inspeccionar el contenedor " + name) from exc


def image_id(name: str) -> str:
    return docker("image", "inspect", "--format={{.Id}}", name)


def migration_head() -> str:
    out = docker("exec", "-w", "/app", PROJECT + "-backend-1", "alembic", "current")
    lines = [line.strip() for line in out.splitlines() if line.strip()]
    if lines != ["f21i00000001 (head)"]:
        raise GateError("Alembic no coincide con f21i00000001")
    return "f21i00000001"


def ready() -> bool:
    try:
        with urlopen(READY, timeout=8) as p:
            if p.status != 200:
                return False
            data = json.loads(p.read(20480))
            return (data.get("ready") is True and
                    data.get("database") is True and
                    data.get("redis") is True and
                    data.get("version") == VERSION)
    except (URLError, HTTPError, OSError, TimeoutError, ValueError):
        return False


def check_runtime() -> None:
    for service in ("backend", "worker", "db", "redis"):
        d = inspect(PROJECT + "-" + service + "-1")
        labels = (d.get("Config") or {}).get("Labels") or {}
        if labels.get("com.docker.compose.project") != PROJECT or \
           labels.get("com.docker.compose.service") != service:
            raise GateError("Identidad Compose inesperada: " + service)
        state = d.get("State") or {}
        if not state.get("Running") or (service in ("backend", "db", "redis")
             and (state.get("Health") or {}).get("Status") != "healthy"):
            raise GateError("Servicio no sano: " + service)
        if service in ROLLBACK and d.get("Image") != ROLLBACK[service][0]:
            raise GateError("Imagen LIVE cambió: " + service)
        if service in ROLLBACK and image_id(ROLLBACK[service][1]) != ROLLBACK[service][0]:
            raise GateError("Falta etiqueta de rollback original: " + service)
    backend = inspect(PROJECT + "-backend-1")
    env = {}
    for entry in (backend.get("Config") or {}).get("Env") or []:
        if "=" in entry:
            k, v = entry.split("=", 1)
            if k in {"ENVIRONMENT", "AUTO_MIGRATE_ON_START",
                     "UVICORN_FORWARDED_ALLOW_IPS",
                     "WITHDRAWALS_LIVE_ENABLED", "WITHDRAWALS_EXECUTION_ENABLED"}:
                env[k] = v.strip()
    if env.get("ENVIRONMENT", "").lower() != "production":
        raise GateError("ENVIRONMENT no es production: requiere revisión manual")
    if env.get("AUTO_MIGRATE_ON_START", "false").lower() in ("true", "yes", "on", "1"):
        raise GateError("AUTO_MIGRATE_ON_START=true, arranque nuevo rechazaría esta configuración")
    if env.get("UVICORN_FORWARDED_ALLOW_IPS", "127.0.0.1") == "*":
        raise GateError("El proxy de producción permite wildcard; revisar manualmente")
    if env.get("WITHDRAWALS_EXECUTION_ENABLED", "false").lower() in ("true", "yes", "on", "1") or \
       env.get("WITHDRAWALS_LIVE_ENABLED", "false").lower() in ("true", "yes", "on", "1"):
        raise GateError("Hay retiros LIVE activos: requiere ventana y conciliación financiera")
    if migration_head() != "f21i00000001" or not ready():
        raise GateError("La API/Alembic actual no está saludable")
    print("KALI_RUNTIME_GATES_PASS: servicios, rollback, migración y startup")


def image_manifest() -> dict:
    if not MANIFEST.is_file() or MANIFEST.is_symlink():
        raise GateError("No existe imagen candidata preparada")
    data = json.loads(MANIFEST.read_text())
    if data.get("sha") != SHA or data.get("image_tag") != IMAGE:
        raise GateError("Manifiesto no corresponde a SHA fijo")
    if image_id(IMAGE) != data.get("image_id"):
        raise GateError("La imagen candidata cambió tras su preparación")
    rev = docker("image", "inspect", "--format={{index .Config.Labels \"org.opencontainers.image.revision\"}}", IMAGE)
    if rev != SHA:
        raise GateError("Imagen candidata no contiene el SHA aprobado")
    return data


def prepare() -> None:
    check_git_and_backup()
    check_runtime()
    print("Construyendo imagen candidata aislada, sin recrear servicios...")
    docker("build", "--pull", "--label", "org.opencontainers.image.revision=" + SHA,
           "--tag", IMAGE, str(REPO / "backend"), timeout=2400)
    user = docker("image", "inspect", "--format={{.Config.User}}", IMAGE)
    if user != "talaeats":
        raise GateError("La imagen no ejecuta como usuario sin privilegios")
    docker("run", "--rm", "--network=none", "--entrypoint=python", IMAGE,
           "-c", "import app.main; from app.config import settings; "
                 "assert settings.app_version == '1.6.4-connect-selfservice-hf1'",
           timeout=120)
    # Verify immutability at time of preparation.
    image_id_value = image_id(IMAGE)
    STATE.mkdir(parents=True, mode=0o700, exist_ok=True)
    fd = os.open(MANIFEST, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"sha": SHA, "version": VERSION, "image_tag": IMAGE,
                   "image_id": image_id_value}, f, sort_keys=True)
        f.write("\n")
    print("KALI_CANDIDATE_PREPARED_PASS")
    print("No se cambiaron los contenedores, PostgreSQL, Caddy o pagos.")


def compose_cmd(override: Path, *actions: str) -> str:
    return run("docker", "compose", "-p", PROJECT,
               "--project-directory", str(LIVE), "-f", str(COMPOSE),
               "-f", str(override), *actions, timeout=180)


def override_yaml(tag_for_service: dict[str, str]) -> str:
    for image in tag_for_service.values():
        if image not in (IMAGE, *[x[1] for x in ROLLBACK.values()]):
            raise GateError("No se permite ninguna imagen desconocida")
    return ("services:\n"
            "  backend:\n    image: " + tag_for_service["backend"] + "\n"
            "  worker:\n    image: " + tag_for_service["worker"] + "\n")


def write_overlay(dir_: Path, images: dict[str, str]) -> Path:
    f = dir_ / "release-override.yml"
    f.write_text(override_yaml(images), encoding="utf-8")
    return f


def validate_compose(override: Path, expected: dict[str, str]) -> None:
    # Compose's JSON contains real environment values: read only in memory,
    # never print, log, or save the resolved compose config!
    parsed = json.loads(compose_cmd(override, "config", "--format", "json"))
    if parsed.get("name") not in (None, PROJECT):
        raise GateError("Nombre Compose inesperado")
    svcs = parsed.get("services") or {}
    for service, tag in expected.items():
        if (svcs.get(service) or {}).get("image") != tag:
            raise GateError("Override de imagen incorrecto en " + service)
        if not (svcs.get(service) or {}).get("build"):
            raise GateError("Servicio sin build original: " + service)
    for protected in ("db", "redis", "frontend", "caddy"):
        if protected not in svcs:
            raise GateError("Falta servicio protegido: " + protected)


def wait_health(seconds=100) -> None:
    start = time.monotonic()
    while time.monotonic() - start < seconds:
        try:
            d = inspect(PROJECT + "-backend-1")
            w = inspect(PROJECT + "-worker-1")
            if (d.get("State") or {}).get("Health", {}).get("Status") == "healthy" and \
               (w.get("State") or {}).get("Running") and ready():
                return
        except (GateError, OSError):
            pass
        time.sleep(3)
    raise GateError("Nueva imagen no alcanzó readiness o worker no corrió")


def deploy(confirm: str) -> None:
    if confirm != SHA:
        raise GateError("Debes confirmar el SHA exacto en --confirm")
    if os.environ.get("TALA_OFFSITE_BACKUP_VERIFIED") != "YES" or \
       os.environ.get("TALA_ISOLATED_RESTORE_VERIFIED") != "YES":
        raise GateError("Bloqueado: falta copia externa SHA256 y RESTAURACIÓN aislada probada")
    check_git_and_backup()
    check_runtime()
    image_manifest()
    with tempfile.TemporaryDirectory(prefix="tala-deploy-") as tmp:
        root = Path(tmp)
        images = {"backend": IMAGE, "worker": IMAGE}
        overlay = write_overlay(root, images)
        validate_compose(overlay, images)
        print("GO: reconstruir SOLO backend y worker con imagen aprobada.")
        try:
            compose_cmd(overlay, "up", "-d", "--no-deps", "--no-build", "backend", "worker")
            wait_health()
            backend = inspect(PROJECT + "-backend-1")
            worker = inspect(PROJECT + "-worker-1")
            if backend.get("Image") != image_id(IMAGE) or worker.get("Image") != image_id(IMAGE):
                raise GateError("API/worker no están ejecutando la imagen candidata")
        except (GateError, ValueError):
            print("HEALTH_FAIL: intentando restaurar imágenes anteriores (sin DB rollback)", file=sys.stderr)
            old = {service: image[1] for service, image in ROLLBACK.items()}
            restore = write_overlay(root, old)
            validate_compose(restore, old)
            try:
                compose_cmd(restore, "up", "-d", "--no-deps", "--no-build", "backend", "worker")
                wait_health()
                print("CODE_ROLLBACK_ATTEMPTED: verificar manualmente estado, pagos, worker", file=sys.stderr)
            except (GateError, ValueError):
                print("CRITICAL: rollback del código no confirmado, intervención operador necesaria", file=sys.stderr)
            raise
    print("KALI_CODE_DEPLOY_PASS: " + SHA)
    print("DB/Redis/Caddy/media no migrados ni reiniciados; verificar conciliación y logs sanitizados.")


def self_test() -> None:
    assert len(SHA) == 40
    assert "backend:" in override_yaml({"backend": IMAGE, "worker": IMAGE})
    try:
        override_yaml({"backend": "unapproved", "worker": IMAGE})
    except GateError:
        pass
    else:
        raise AssertionError("Se aceptó imagen no autorizada")
    assert not os.environ.get("TALA_ISOLATED_RESTORE_VERIFIED") == "maybe"
    print("KALI_OPERATOR_DEPLOY_GUARDS_SELFTEST_PASS")


def main() -> None:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--self-test", action="store_true")
    g.add_argument("--prepare", action="store_true")
    g.add_argument("--deploy", action="store_true")
    ap.add_argument("--confirm", default="")
    args = ap.parse_args()
    STATE.mkdir(parents=True, mode=0o700, exist_ok=True)
    lock = STATE / "release.lock"
    with lock.open("a+") as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            if args.self_test:
                self_test()
            elif args.prepare:
                prepare()
            else:
                deploy(args.confirm)
        except (GateError, OSError, ValueError, json.JSONDecodeError,
                subprocess.SubprocessError) as exc:
            print("KALI_RELEASE_BLOCKED: " + str(exc), file=sys.stderr)
            sys.exit(2)


if __name__ == "__main__":
    main()
