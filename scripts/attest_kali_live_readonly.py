#!/usr/bin/env python3
"""F2.02 read-only Kali attestation of API, worker, Alembic and /ready.

Must be run ON Kali from a clean GitHub checkout: this script does not use SSH,
write database records, read environment variables/secrets, or deploy anything.
A CI --self-test validates *logic* only; it cannot attest the actual host.
"""
from __future__ import annotations

import argparse
import ast
from io import BytesIO
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
from unittest.mock import patch
from urllib.parse import urlsplit
from urllib.request import urlopen


PATHS = ("app", "migrations", "entrypoint.sh", "requirements.txt")
PROJECT = "talaeats-v3"
API = "talaeats-v3-backend-1"
WORKER = "talaeats-v3-worker-1"
READY_ALLOWED_HOSTS = {"localhost", "127.0.0.1", "talaeats.alan-palacios-dev.com"}
REVISION = re.compile(r"(?m)^\s*([A-Za-z0-9_]+)\s+\(head\)\s*$")


def run(*cmd: str) -> str:
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=45)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("Falló consulta local de solo lectura: " + cmd[0]) from exc
    if result.returncode != 0:
        # Do not print Docker / Git stderr: it can include sensitive host paths.
        raise RuntimeError("Consulta local de solo lectura denegada: " + cmd[0])
    return result.stdout.strip()


def version(source: Path) -> str:
    data = ast.parse((source / "app" / "config.py").read_text(encoding="utf-8"))
    for node in data.body:
        if isinstance(node, ast.ClassDef) and node.name == "Settings":
            for stmt in node.body:
                if isinstance(stmt, ast.Assign) and any(
                    isinstance(t, ast.Name) and t.id == "app_version"
                    for t in stmt.targets
                ):
                    value = ast.literal_eval(stmt.value)
                    if isinstance(value, str):
                        return value
    raise RuntimeError("app_version no encontrada en config.py")


def digest(directory: Path) -> dict[str, str]:
    result = {}
    for entry in PATHS:
        path = directory / entry
        if not path.exists():
            raise RuntimeError("Fuente requerida ausente: " + entry)
        files = [path] if path.is_file() else path.rglob("*")
        for file in files:
            if file.is_file() and (file.suffix == ".py" or
                                   file.name in {"entrypoint.sh", "requirements.txt"}):
                name = file.relative_to(directory).as_posix()
                result[name] = hashlib.sha256(file.read_bytes()).hexdigest()
    if not result:
        raise RuntimeError("No se pudieron calcular hashes de fuentes")
    return result


def differences(reference: dict[str, str], runtime: dict[str, str]) -> dict:
    missing = sorted(set(reference) - set(runtime))
    extra = sorted(set(runtime) - set(reference))
    mismatch = sorted(k for k in reference.keys() & runtime.keys()
                      if reference[k] != runtime[k])
    return {
        "files_compared": len(reference),
        "missing_count": len(missing),
        "extra_count": len(extra),
        "mismatch_count": len(mismatch),
        "missing_sample": missing[:10],
        "extra_sample": extra[:10],
        "mismatch_sample": mismatch[:10],
        "matching": not (missing or extra or mismatch),
    }


def validate_ready_target(uri: str) -> None:
    parsed = urlsplit(uri)
    if (parsed.path != "/api/v1/ready" or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.hostname not in READY_ALLOWED_HOSTS
            or parsed.scheme not in {"http", "https"}):
        raise RuntimeError("URL /ready fuera de allowlist")
    if parsed.hostname == "talaeats.alan-palacios-dev.com" and parsed.scheme != "https":
        raise RuntimeError("HTTPS obligatorio fuera de localhost")


def validate_ready_json(status, expected: str) -> None:
    if not isinstance(status, dict):
        raise RuntimeError("Respuesta /ready no es objeto JSON")
    if status.get("version") != expected:
        raise RuntimeError("Versión /ready no coincide con checkout")
    for key in ("ready", "database", "redis"):
        if status.get(key) is not True:
            raise RuntimeError("Dependencia no lista en /ready: " + key)


def check_ready(uri: str, expected: str) -> None:
    validate_ready_target(uri)
    with urlopen(uri, timeout=10) as response:
        status = json.load(response)
    validate_ready_json(status, expected)


def verify_compose_identity(container: str, service: str) -> tuple[str, str]:
    labels = json.loads(run("docker", "inspect", "--type=container",
                            "--format", "{{json .Config.Labels}}", container))
    if (not isinstance(labels, dict) or
            labels.get("com.docker.compose.project") != PROJECT or
            labels.get("com.docker.compose.service") != service):
        raise RuntimeError("Proyecto o servicio Docker inesperado: " + service)
    running = run("docker", "inspect", "--type=container", "--format",
                  "{{.State.Running}}", container)
    if running != "true":
        raise RuntimeError("Contenedor no está activo: " + service)
    # Only API currently has a Docker healthcheck guarantee.
    if service == "backend":
        health = run("docker", "inspect", "--type=container", "--format",
                     "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", container)
        if health != "healthy":
            raise RuntimeError("API no está healthy")
    image_id = run("docker", "inspect", "--type=container", "--format",
                   "{{.Image}}", container)
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
        raise RuntimeError("Imagen Docker sin SHA-256 verificable")
    return image_id, service


def alembic_single_head(current: str, heads: str) -> str:
    active = REVISION.findall(current)
    declared = REVISION.findall(heads)
    if len(active) != 1 or len(declared) != 1 or active != declared:
        raise RuntimeError("Alembic actual no coincide con HEAD único")
    return active[0]


def copy_runtime_sources(container: str, dest: Path) -> dict[str, str]:
    dest.mkdir(parents=True, exist_ok=True)
    for entry in PATHS:
        # Copies into a disposable temp directory, never into the checkout.
        run("docker", "cp", container + ":/app/" + entry, str(dest / entry))
    return digest(dest)


def self_test() -> None:
    with tempfile.TemporaryDirectory(prefix="tala-f202-selftest-") as temp:
        left, right = (Path(temp) / "left", Path(temp) / "right")
        for root in (left, right):
            (root / "app").mkdir(parents=True)
            (root / "migrations").mkdir()
            (root / "app" / "config.py").write_text(
                "class Settings:\n    app_version = 'qa-f202'\n", encoding="utf-8")
            (root / "migrations" / "rev.py").write_text("revision='f21-test'\n", encoding="utf-8")
            (root / "entrypoint.sh").write_text("# qa only\n", encoding="utf-8")
            (root / "requirements.txt").write_text("# synthetic\n", encoding="utf-8")
        assert version(left) == "qa-f202"
        expected = digest(left)
        assert differences(expected, digest(right))["matching"]
        (right / "app" / "config.py").write_text(
            "class Settings:\n    app_version = 'other'\n", encoding="utf-8")
        assert differences(expected, digest(right))["mismatch_count"] == 1
        (right / "app" / "config.py").unlink()
        assert differences(expected, digest(right))["missing_count"] == 1
        (right / "app" / "extra.py").write_text("x=1\n", encoding="utf-8")
        assert differences(expected, digest(right))["extra_count"] == 1
    assert alembic_single_head("f21i00000001 (head)\n", "f21i00000001 (head)\n") == "f21i00000001"
    for curr, heads in [
        ("f20h00000001\n", "f21i00000001 (head)\n"),
        ("f21i00000001 (head)\n", "f20h00000001 (head)\n"),
        ("f21i00000001 (head)\n", "f21i00000001 (head)\nf22j00000001 (head)\n"),
    ]:
        try:
            alembic_single_head(curr, heads)
        except RuntimeError:
            pass
        else:
            raise AssertionError("Alembic divergence not blocked")
    validate_ready_json({"version": "qa-f202", "ready": True,
                         "database": True, "redis": True}, "qa-f202")
    for status in [
        {"version": "qa-f202", "ready": "true", "database": True, "redis": True},
        {"version": "qa-f202", "ready": True, "database": False, "redis": True},
        {"version": "qa-f202", "ready": True, "database": True, "redis": "true"},
        {"version": "other", "ready": True, "database": True, "redis": True},
        [],
    ]:
        try:
            validate_ready_json(status, "qa-f202")
        except RuntimeError:
            pass
        else:
            raise AssertionError("Unhealthy /ready accepted")
    for target in [
        "https://evil.example/api/v1/ready",
        "http://talaeats.alan-palacios-dev.com/api/v1/ready",
        "http://127.0.0.1:8082/api/v1/ready?key=secret",
        "http://127.0.0.1:8082/api/v1/ready#fragment",
        "http://user:pass@127.0.0.1:8082/api/v1/ready",
    ]:
        try:
            validate_ready_target(target)
        except RuntimeError:
            pass
        else:
            raise AssertionError("Unsafe readiness target accepted")
    validate_ready_target("http://127.0.0.1:8082/api/v1/ready")
    print("F202_API_WORKER_ALEMBIC_SHA256_ATTESTATION_SELFTEST_PASS")


def main() -> None:
    ap = argparse.ArgumentParser(description="Atestación Kali API/worker SOLO LECTURA")
    ap.add_argument("--self-test", action="store_true", help="Sin Docker, SQL ni red")
    ap.add_argument("--repo", default=".")
    ap.add_argument("--api-container", default=API)
    ap.add_argument("--worker-container", default=WORKER)
    ap.add_argument("--ready-url", default="http://127.0.0.1:8082/api/v1/ready")
    args = ap.parse_args()
    if args.self_test:
        self_test()
        return
    root = Path(args.repo).resolve()
    source = root / "backend"
    if not source.is_dir():
        raise RuntimeError("Ejecutar desde la raíz del checkout GitHub")
    rev = run("git", "-C", str(root), "rev-parse", "HEAD")
    if not re.fullmatch(r"[0-9a-f]{40}", rev):
        raise RuntimeError("SHA de git inválido")
    dirty = run("git", "-C", str(root), "status", "--porcelain", "--",
                "backend/app", "backend/migrations", "backend/entrypoint.sh",
                "backend/requirements.txt")
    if dirty:
        raise RuntimeError("Checkout modificado; no certificar runtime")
    expected_version = version(source)
    reference = digest(source)
    containers = (("backend", args.api_container), ("worker", args.worker_container))
    results = {}
    overall = True
    with tempfile.TemporaryDirectory(prefix="tala-f202-runtime-readonly-") as folder:
        for service, container in containers:
            image_id, _ = verify_compose_identity(container, service)
            runtime = copy_runtime_sources(container, Path(folder) / service)
            delta = differences(reference, runtime)
            overall = overall and delta["matching"]
            results[service] = {
                "image_sha256_prefix": image_id[:24],
                **delta,
            }
    # Even if source mismatch, report that discrepancy; never claim success.
    current = run("docker", "exec", "-w", "/app", args.api_container, "alembic", "current")
    heads = run("docker", "exec", "-w", "/app", args.api_container, "alembic", "heads")
    migration_head = alembic_single_head(current, heads)
    print(json.dumps({
        "git_commit": rev,
        "declared_version": expected_version,
        "api_worker_source_match": overall,
        "alembic_head_observed": migration_head,
        "services": results,
        "deployment_authorized": False,
        "live_money_authorized": False,
    }, indent=2, ensure_ascii=False))
    if not overall:
        raise SystemExit("FAIL: API y/o worker no coinciden con fuente GitHub")
    check_ready(args.ready_url, expected_version)
    print("F202_GITHUB_KALI_API_WORKER_ALEMBIC_READY_PASS_ONLY_READS")


if __name__ == "__main__":
    main()
