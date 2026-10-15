#!/usr/bin/env python3
"""TALA EATS / Kali: release vs LIVE diff and rollback readiness, READ ONLY.

Uses git status, docker inspect/cp/exec and local files. Never touches .env,
credentials, payments, volumes, DB contents, or executes Docker Compose actions.
A PASS means the inventory is valid, NOT permission to deploy.
"""
import argparse
import ast
import hashlib
import json
import re
import subprocess
import tempfile
from pathlib import Path

PROJECT = "talaeats-v3"
API = "talaeats-v3-backend-1"
WORKER = "talaeats-v3-worker-1"
DB = "talaeats-v3-db-1"
REDIS = "talaeats-v3-redis-1"
RUNTIME_PATHS = ("app", "migrations", "requirements.txt", "entrypoint.sh")


def run(*args):
    try:
        p = subprocess.run(args, capture_output=True, text=True, check=False, timeout=65)
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError("No fue posible completar una consulta local de solo lectura") from None
    if p.returncode:
        # Do not print stderr from Docker or Git: could include host configuration.
        raise RuntimeError("Consulta de solo lectura falló: " + args[0])
    return p.stdout.strip()


def revision_heads(versions_dir):
    revisions = {}
    for path in versions_dir.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=path.name)
        vals = {}
        for node in tree.body:
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                names = [n.id for n in node.targets if isinstance(n, ast.Name)] if isinstance(node, ast.Assign) \
                    else [node.target.id] if isinstance(node.target, ast.Name) else []
                for n in names:
                    if n in {"revision", "down_revision"}:
                        vals[n] = ast.literal_eval(node.value)
        if not isinstance(vals.get("revision"), str):
            raise RuntimeError("Migración sin revision literal: " + path.name)
        revisions[vals["revision"]] = vals.get("down_revision")
    if not revisions:
        raise RuntimeError("No se encontraron migraciones")
    parents = set()
    for prev in revisions.values():
        if prev is None:
            continue
        if isinstance(prev, str):
            parents.add(prev)
        elif isinstance(prev, (tuple, list)):
            parents.update(prev)
        else:
            raise RuntimeError("down_revision no soportada; revisión manual requerida")
    return sorted(set(revisions) - parents)


def version(source):
    tree = ast.parse((source / "app" / "config.py").read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "Settings":
            for child in node.body:
                if isinstance(child, ast.Assign) and any(
                    isinstance(t, ast.Name) and t.id == "app_version" for t in child.targets
                ):
                    value = ast.literal_eval(child.value)
                    if isinstance(value, str):
                        return value
    raise RuntimeError("No se puede determinar versión candidata")


def digests(source):
    hashes = {}
    for part in RUNTIME_PATHS:
        root = source / part
        if not root.exists():
            raise RuntimeError("Código requerido ausente: " + part)
        for item in ([root] if root.is_file() else root.rglob("*")):
            if item.is_file() and (item.suffix == ".py" or item.name in {"requirements.txt", "entrypoint.sh"}):
                hashes[item.relative_to(source).as_posix()] = hashlib.sha256(item.read_bytes()).hexdigest()
    return hashes


def inspect(container, field):
    return run("docker", "inspect", "--type=container", "--format", field, container)


def migration_at_runtime():
    current = run("docker", "exec", "-w", "/app", API, "alembic", "current")
    heads = run("docker", "exec", "-w", "/app", API, "alembic", "heads")
    matches_current = re.findall(r"(?m)^([a-zA-Z0-9_]+)\s+\(head\)", current)
    matches_heads = re.findall(r"(?m)^([a-zA-Z0-9_]+)\s+\(head\)", heads)
    if len(matches_current) != 1 or matches_current != matches_heads:
        raise RuntimeError("Alembic en producción no tiene una única revisión HEAD actual")
    return matches_current[0]


def self_test():
    with tempfile.TemporaryDirectory() as name:
        d = Path(name)
        (d / "one.py").write_text("revision='a1'\ndown_revision=None\n", encoding="utf-8")
        (d / "two.py").write_text("revision='b2'\ndown_revision='a1'\n", encoding="utf-8")
        assert revision_heads(d) == ["b2"]
        (d / "three.py").write_text("revision='c3'\ndown_revision='a1'\n", encoding="utf-8")
        assert revision_heads(d) == ["b2", "c3"]
        assert hashlib.sha256(b"a").hexdigest() != hashlib.sha256(b"b").hexdigest()
    print("KALI_RELEASE_PLAN_SELFTEST_PASS")


def plan(repo):
    source = repo / "backend"
    if not (repo / ".git").is_dir() or not source.is_dir():
        raise RuntimeError("Debe ejecutarse desde un checkout GitHub completo")
    head = run("git", "-C", str(repo), "rev-parse", "HEAD")
    dirty = run("git", "-C", str(repo), "status", "--porcelain", "--", "backend")
    if dirty:
        raise RuntimeError("Los archivos del backend tienen cambios sin confirmar")
    candidate_version = version(source)
    candidate_heads = revision_heads(source / "migrations" / "versions")
    if len(candidate_heads) != 1:
        raise RuntimeError("Candidato tiene múltiples heads Alembic")

    containers = {}
    for container, service in ((API, "backend"), (WORKER, "worker"), (DB, "db"), (REDIS, "redis")):
        labels = json.loads(inspect(container, "{{json .Config.Labels}}"))
        if labels.get("com.docker.compose.project") != PROJECT or \
           labels.get("com.docker.compose.service") != service:
            raise RuntimeError("Docker Compose labels no coinciden con el proyecto permitido")
        state = inspect(container, "{{.State.Status}}")
        health = inspect(container, "{{if .State.Health}}{{.State.Health.Status}}{{else}}sin-healthcheck{{end}}")
        if state != "running" or (service in {"backend", "db", "redis"} and health != "healthy"):
            raise RuntimeError("Contenedor sin salud esperada: " + service)
        containers[service] = {
            "image_id": inspect(container, "{{.Image}}"),
            "state": state, "health": health,
        }

    db_head = migration_at_runtime()
    reference = digests(source)
    with tempfile.TemporaryDirectory(prefix="tala-release-plan-") as tmp:
        dest = Path(tmp)
        for part in RUNTIME_PATHS:
            run("docker", "cp", API + ":/app/" + part, str(dest / part))
        live = digests(dest)

    changed = sorted(k for k in reference.keys() & live.keys() if reference[k] != live[k])
    missing_in_runtime = sorted(set(reference) - set(live))
    missing_in_candidate = sorted(set(live) - set(reference))
    if not changed and not missing_in_runtime and not missing_in_candidate:
        relationship = "identical_runtime"
    else:
        relationship = "runtime_changes_require_staging"

    # No deploy or rollback can run from this file, even if the candidate matches.
    output = {
        "git_sha_candidate": head,
        "candidate_version": candidate_version,
        "runtime_relationship": relationship,
        "files_compared": len(reference),
        "modified_files": changed[:40],
        "new_files": missing_in_runtime[:40],
        "removed_files": missing_in_candidate[:40],
        "candidate_alembic_head": candidate_heads[0],
        "production_alembic_head": db_head,
        "migration_change": candidate_heads[0] != db_head,
        "containers": containers,
        "production_release_authorized": False,
        "missing_gates": [
            "respaldo PostgreSQL cifrado y restauración probada",
            "respaldo/restauración de volumen media y configuración Compose",
            "pruebas de deploy/rollback de API + worker en laboratorio aislado",
            "comprobación de migraciones en réplica y compatibilidad retroactiva",
            "verificación de worker y finanzas antes de liberar Stripe LIVE",
            "aprobación manual de ventana de despliegue y SHA inmutable",
        ],
    }
    print(json.dumps(output, indent=2, ensure_ascii=False))
    print("KALI_RELEASE_PLAN_READONLY_PASS - no backup, build, deploy, migration or rollback")


def main():
    ap = argparse.ArgumentParser(description="Plan de release TALA EATS, SOLO LECTURA")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--repo", default=str(Path.home() / "tala-backend-audit"))
    args = ap.parse_args()
    try:
        if args.self_test:
            self_test()
        else:
            plan(Path(args.repo).resolve())
    except (RuntimeError, OSError, SyntaxError, ValueError, KeyError, AssertionError) as exc:
        print("KALI_RELEASE_PLAN_READONLY_FAIL:", str(exc))
        raise SystemExit(2) from None


if __name__ == "__main__":
    main()
