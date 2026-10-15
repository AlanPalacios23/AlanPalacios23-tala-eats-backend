#!/usr/bin/env python3
"""Conservar imágenes ACTUALES como anclas locales para rollback de código.

DEFAULT = --dry-run. --pin solo crea ETIQUETAS de imágenes Docker y un manifiesto
local sin secretos. Nunca toca contenedores, PostgreSQL, volúmenes, Compose o Stripe.
No es un mecanismo completo de deploy/rollback: requieren backups restaurables.
"""
import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path
from urllib.request import urlopen

PROJECT = "talaeats-v3"
VERSION = "1.6.4-connect-selfservice-hf1"
HEAD = "f21i00000001"
READY_URL = "http://127.0.0.1:8082/api/v1/ready"

# Anclas confirmadas por docker inspect realizado en Kali 2026-10-15.
EXPECTED = {
    "backend": {
        "container": "talaeats-v3-backend-1",
        "image": "sha256:3b1d89ec510d6768eacd27122a32e3bf0feffbe4a7937911f0f4defeda062360",
        "tag": "talaeats-rollback/backend:v1.6.4-hf1-e22e4d5",
    },
    "worker": {
        "container": "talaeats-v3-worker-1",
        "image": "sha256:624d02c855ec2d712f48d81ff32ab4019c78762e02e91a55bd59a2fa5d96246a",
        "tag": "talaeats-rollback/worker:v1.6.4-hf1-e22e4d5",
    },
}


def docker(*args, allow_missing=False):
    p = subprocess.run(["docker", *args], check=False, capture_output=True, text=True, timeout=45)
    if p.returncode:
        if allow_missing:
            return None
        # Avoid including stderr or Docker runtime env in output.
        raise RuntimeError("Docker no pudo completar una inspección o etiquetado autorizado")
    return p.stdout.strip()


def inspect(container, template):
    return docker("inspect", "--type", "container", "--format", template, container)


def image_id(name):
    return docker("image", "inspect", "--format", "{{.Id}}", name, allow_missing=True)


def validate_image_ids(current):
    for service, expected in EXPECTED.items():
        if current.get(service) != expected["image"]:
            raise RuntimeError(
                "ABORTADO: la imagen LIVE de " + service + " cambió respecto a la evidencia aprobada"
            )


def verify_live():
    ids = {}
    for service, details in EXPECTED.items():
        name = details["container"]
        labels = json.loads(inspect(name, "{{json .Config.Labels}}"))
        if labels.get("com.docker.compose.project") != PROJECT or labels.get("com.docker.compose.service") != service:
            raise RuntimeError("ABORTADO: las etiquetas Compose no coinciden: " + service)
        state = inspect(name, "{{.State.Status}}")
        health = inspect(name, "{{if .State.Health}}{{.State.Health.Status}}{{else}}sin-healthcheck{{end}}")
        if state != "running" or (service == "backend" and health != "healthy"):
            raise RuntimeError("ABORTADO: contenedor LIVE no está en estado esperado: " + service)
        ids[service] = inspect(name, "{{.Image}}")
    validate_image_ids(ids)
    for service, details in EXPECTED.items():
        if image_id(details["image"]) != details["image"]:
            raise RuntimeError("ABORTADO: falta imagen Docker original: " + service)

    with urlopen(READY_URL, timeout=10) as response:
        payload = json.load(response)
    if payload.get("ready") is not True or payload.get("version") != VERSION:
        raise RuntimeError("ABORTADO: la API READY no coincide con versión live verificada")
    if payload.get("database") is not True or payload.get("redis") is not True:
        raise RuntimeError("ABORTADO: DB/Redis no reportan ready")
    alembic = docker("exec", "-w", "/app", "talaeats-v3-backend-1", "alembic", "current")
    if not any(line.strip() == HEAD + " (head)" for line in alembic.splitlines()):
        raise RuntimeError("ABORTADO: migración de producción inesperada")
    return ids


def tags_to_apply(lookup):
    additions = []
    for service, item in EXPECTED.items():
        exists = lookup(item["tag"])
        if exists is not None and exists != item["image"]:
            raise RuntimeError("ABORTADO: etiqueta ya existe y apunta a otra imagen: " + service)
        if exists is None:
            additions.append(service)
    return additions


def manifest_path():
    return Path.home() / ".local" / "share" / "talaeats" / "rollback-manifests" / "v1.6.4-hf1-e22e4d5.json"


def write_manifest(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    if path.exists():
        old = json.loads(path.read_text(encoding="utf-8"))
        if old != data:
            raise RuntimeError("ABORTADO: manifiesto previo es distinto, no se sobrescribe")
        return
    # Atomic file; no secrets, permissions 0600.
    fd, tmp = tempfile.mkstemp(prefix=".tala-rollback-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(data, out, ensure_ascii=False, indent=2)
            out.write("\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def self_test():
    valid = {name: value["image"] for name, value in EXPECTED.items()}
    validate_image_ids(valid)
    try:
        validate_image_ids({**valid, "backend": "sha256:changed"})
    except RuntimeError:
        pass
    else:
        raise AssertionError("image mismatch was accepted")
    assert tags_to_apply(lambda _: None) == ["backend", "worker"]
    assert tags_to_apply(lambda tag: EXPECTED["backend"]["image"] if tag == EXPECTED["backend"]["tag"] else None) == ["worker"]
    try:
        tags_to_apply(lambda _: "sha256:somebody-else")
    except RuntimeError:
        pass
    else:
        raise AssertionError("collision was accepted")
    # Selftest never calls Docker.
    print("KALI_ROLLBACK_IMAGE_PIN_SELFTEST_PASS")


def main():
    p = argparse.ArgumentParser(description="Anclas de imágenes para recuperación - v1.6.4, no deploy")
    modes = p.add_mutually_exclusive_group()
    modes.add_argument("--dry-run", action="store_true", help="Solo validar y proponer etiquetas (default)")
    modes.add_argument("--pin", action="store_true", help="Etiquetar imágenes verificadas, SIN reiniciar contenedores")
    modes.add_argument("--self-test", action="store_true", help="Probar seguridad sin acceder a Docker")
    args = p.parse_args()

    if args.self_test:
        return self_test()
    ids = verify_live()
    to_create = tags_to_apply(image_id)
    result = {
        "mode": "PIN_ONLY" if args.pin else "DRY_RUN",
        "runtime_version": VERSION,
        "alembic_head": HEAD,
        "containers_unchanged": True,
        "images": [
            {"service": service, "live_id": ids[service], "rollback_tag": details["tag"],
             "already_pinned": service not in to_create}
            for service, details in EXPECTED.items()
        ],
        "database_backup_verified": False,
        "media_backup_verified": False,
        "rollback_ready": False,
    }
    if args.pin:
        for service in to_create:
            data = EXPECTED[service]
            docker("image", "tag", data["image"], data["tag"])
        # Both tags must resolve to EXACT original image IDs.
        if tags_to_apply(image_id):
            raise RuntimeError("No se pudieron confirmar todas las etiquetas")
        record = {
            "release": VERSION, "migration_head": HEAD,
            "images": {service: {"id": data["image"], "tag": data["tag"]}
                       for service, data in EXPECTED.items()},
            "requires_db_and_media_backup": True,
        }
        write_manifest(manifest_path(), record)
        result["image_pins_verified"] = True
        result["manifest"] = str(manifest_path())
        result["message"] = "IMAGES_PINNED_PASS; no es respaldo DB/media ni rollback operativo"
    else:
        result["pending_tags"] = to_create
        result["message"] = "DRY_RUN_PASS; no se etiquetó ninguna imagen"
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        print("KALI_ROLLBACK_IMAGE_PIN_FAIL:", str(exc))
        raise SystemExit(2) from None
