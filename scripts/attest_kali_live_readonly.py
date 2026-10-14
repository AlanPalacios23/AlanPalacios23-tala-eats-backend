#!/usr/bin/env python3
"""Read-only attestation: compare checked-out GitHub sources with ACTIVE Kali Docker.

Run ON Kali against a clean checkout. Never reads .env, Docker env, DB, media or
private keys. A healthy /ready alone is NOT evidence of matching source.
"""
import argparse
import ast
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import urlopen


PATHS = ("app", "migrations", "entrypoint.sh", "requirements.txt")


def run(*cmd):
    return subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=45).stdout.strip()


def version(source):
    data = ast.parse((source / "app" / "config.py").read_text(encoding="utf-8"))
    for node in data.body:
        if isinstance(node, ast.ClassDef) and node.name == "Settings":
            for stmt in node.body:
                if isinstance(stmt, ast.Assign) and any(
                    isinstance(t, ast.Name) and t.id == "app_version" for t in stmt.targets
                ):
                    return ast.literal_eval(stmt.value)
    raise RuntimeError("app_version no encontrada en config.py")


def digest(directory):
    result = {}
    for entry in PATHS:
        path = directory / entry
        if not path.exists():
            raise RuntimeError("Fuente requerida ausente: " + entry)
        files = [path] if path.is_file() else list(path.rglob("*"))
        for f in files:
            if f.is_file() and (f.suffix == ".py" or f.name in {"entrypoint.sh", "requirements.txt"}):
                name = f.relative_to(directory).as_posix()
                result[name] = hashlib.sha256(f.read_bytes()).hexdigest()
    return result


def check_ready(uri, expected):
    parsed = urlsplit(uri)
    if parsed.path != "/api/v1/ready" or parsed.username or parsed.password:
        raise RuntimeError("Ready URL inválida")
    if parsed.hostname not in {"localhost", "127.0.0.1", "talaeats.alan-palacios-dev.com"}:
        raise RuntimeError("Host de ready no está en allowlist")
    if parsed.hostname == "talaeats.alan-palacios-dev.com" and parsed.scheme != "https":
        raise RuntimeError("HTTPS obligatorio fuera del host local")
    if parsed.scheme not in {"http", "https"}:
        raise RuntimeError("Protocolo inválido")
    with urlopen(uri, timeout=10) as response:
        status = json.load(response)
    if not status.get("ready") or status.get("version") != expected:
        raise RuntimeError("API no está lista o versión inconsistente; no publicar")
    return True


def main():
    ap = argparse.ArgumentParser(description="Comparación segura GitHub-Kali (solo lectura)")
    ap.add_argument("--repo", default=".", help="Root de la carpeta clonada de GitHub")
    ap.add_argument("--container", default="talaeats-v3-backend-1")
    ap.add_argument("--ready-url", default="http://127.0.0.1:8082/api/v1/ready")
    args = ap.parse_args()
    root = Path(args.repo).resolve()
    source = root / "backend"
    assert source.is_dir(), "Ejecutar desde la raíz clonada del repositorio"
    rev = run("git", "-C", str(root), "rev-parse", "HEAD")
    dirty = run("git", "-C", str(root), "status", "--porcelain", "--", "backend/app", "backend/migrations",
                "backend/entrypoint.sh", "backend/requirements.txt")
    if dirty:
        raise RuntimeError("El árbol de código está modificado; use un checkout limpio")
    expected_version = version(source)
    state = run("docker", "inspect", "--format", "{{.State.Running}}:{{.State.Health.Status}}", args.container)
    if state != "true:healthy":
        raise RuntimeError("El contenedor no está healthy: " + state)
    image_id = run("docker", "inspect", "--format", "{{.Image}}", args.container)
    reference = digest(source)
    with tempfile.TemporaryDirectory(prefix="tala-verify-readonly-") as temp:
        dest = Path(temp)
        for entry in PATHS:
            run("docker", "cp", args.container + ":/app/" + entry, str(dest / entry))
        running = digest(dest)

    missing = sorted(set(reference) - set(running))
    extra = sorted(set(running) - set(reference))
    mismatch = sorted(k for k in reference.keys() & running.keys() if reference[k] != running[k])
    result = {
        "git_commit": rev, "declared_version": expected_version,
        "docker_image_prefix": image_id[:24], "files_compared": len(reference),
        "missing": missing[:20], "extra": extra[:20], "mismatch": mismatch[:20],
        "full_source_match": not (missing or extra or mismatch)
    }
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if not result["full_source_match"]:
        raise SystemExit("FAIL: GitHub NO coincide con el código activo de Kali")
    check_ready(args.ready_url, expected_version)
    print("GITHUB_KALI_SOURCE_AND_READY_PASS — solo lectura, no hubo deploy ni migraciones")


if __name__ == "__main__":
    main()
