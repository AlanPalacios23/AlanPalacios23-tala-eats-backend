#!/usr/bin/env python3
"""Kali server cleanup after stopping/removing 21 non-Tala Eats containers.

Offline --self-test, read-only --plan, destructive --delete requiring exact phrase.
Never touch Tala Eats (green, v3, ADMIN), Docker daemon, SSH, Cloudflared, or
unclassified/anonymous volumes/images/files. No broad prune commands.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import urllib.request

HOME = pathlib.Path("/home/alan")
CONFIRM = "BORRAR_SOLO_DATOS_NO_TALA"
KEEP_PROJECTS = {"talaeats-green", "talaeats-v3", "talaeats-admin"}
REMOVE_PROJECTS = {
    "codexia-web-beta", "dateclub-v400-staging", "deploy",
    "control_inventario_servidor_interno", "noctra-store-v022-server",
    "psico-whatsapp-bot-v01",
}
# Exact names from Kali operator inventory dated 18 October 2026.
VOLUMES = {
    "codexia-web-beta_codexia_db",
    "codexia-web-beta_codexia_media",
    "control_inventario_servidor_interno_postgres_data",
    "dateclub-v400-staging_dateclub_pg",
    "dateclub-v400-staging_dateclub_redis",
    "deploy_sentinel_postgres",
    "psico-whatsapp-bot-v01_redis_data",
}
NETWORKS = {
    "codexia-web-beta_app_private",
    "codexia-web-beta_sandbox_private",
    "control_inventario_servidor_interno_inventario_internal",
    "dateclub-v400-staging_dateclub_internal",
    "deploy_sentinel_internal",
    "noctra-store-v022-server_default",
    "psico-whatsapp-bot-v01_default",
}
# Directory names actually observed in operator inventory. Only immediate
# children of /home/alan are eligible. NO recursive wildcard expansion.
DIR_PREFIXES = (
    "CODEXIA-", "codexia-", "DATECLUB-", "dateclub-",
    "NOCTRA-", "noctra-", "SENTINEL-", "sentinel-",
    "actualizacion-inventario-", "psico-whatsapp-bot-",
)
DIR_EXACT = {"control_inventario_servidor_interno"}
IMAGE_PREFIXES = (
    "codexia-web-beta-", "dateclub-v400-staging-",
    "control_inventario_servidor_interno-",
    "noctra-store-v022-server-", "deploy-",
    "psico-whatsapp-bot-v01-",
)
EXPECTED_SHA = "d584e2dcad91c46b2dfa2834343d5f7562486bca"
BACKUP_DIR = HOME / "talaeats-backups/20261018T042833Z-encrypted.VkjIWd6q"

def command(*argv: str, timeout: int = 120) -> str:
    p = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       text=True, timeout=timeout, check=False)
    if p.returncode:
        # Docker stderr could include configuration or secrets.
        raise RuntimeError("Error de comando: " + " ".join(argv[:2]))
    return p.stdout.strip()

def try_command(*argv: str) -> bool:
    p = subprocess.run(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=120, check=False)
    return p.returncode == 0

def docker_list(kind: str) -> set[str]:
    cmd = {
        "volume": ["docker", "volume", "ls", "--format", "{{.Name}}"],
        "network": ["docker", "network", "ls", "--format", "{{.Name}}"],
    }[kind]
    return set(command(*cmd).splitlines())

def container_inventory() -> list[dict]:
    result = []
    for s in command("docker", "ps", "-a", "--format",
                     '{{.ID}}|{{.Names}}|{{.Label "com.docker.compose.project"}}|{{.Status}}'
                     ).splitlines():
        bits = s.split("|", 3)
        if len(bits) != 4:
            raise RuntimeError("Inventario contenedor desconocido")
        cid, name, project, status = bits
        result.append(dict(id=cid, name=name, project=project, status=status))
    return result

def verify_green_and_backup(rows: list[dict]) -> None:
    byname = {r["name"]: r for r in rows}
    for name in ("talaeats-green-api-1", "talaeats-green-worker-1",
                 "talaeats-green-db-1", "talaeats-green-redis-1"):
        r = byname.get(name)
        if not r or r["project"] != "talaeats-green" or not r["status"].startswith("Up "):
            raise RuntimeError("No se confirmó funcionamiento GREEN: " + name)
    for r in rows:
        if r["project"] in REMOVE_PROJECTS:
            raise RuntimeError("Aún hay contenedores no-Tala: " + r["name"])
        if r["project"] not in KEEP_PROJECTS and r["status"].startswith("Up "):
            raise RuntimeError("Existe un contenedor activo sin clasificar; detener limpieza")
    try:
        with urllib.request.urlopen("http://127.0.0.1:18182/api/v1/ready", timeout=8) as f:
            ready = json.load(f)
    except (OSError, ValueError) as exc:
        raise RuntimeError("Backend green no responde al readiness") from exc
    if not (ready.get("ready") is True and ready.get("database") is True and
            ready.get("redis") is True and
            ready.get("version") == "1.6.4-connect-selfservice-hf1"):
        raise RuntimeError("GREEN no pasó prueba de readiness")
    if not BACKUP_DIR.is_dir() or BACKUP_DIR.is_symlink():
        raise RuntimeError("Respaldo cifrado de TALA EATS no localizado")
    if not try_command("sha256sum", "--check", "--status", str(BACKUP_DIR / "SHA256SUMS.txt")):
        # sha256sum relative paths must resolve inside backup dir; use cwd below.
        p = subprocess.run(["sha256sum", "--check", "--status", "SHA256SUMS.txt"],
                           cwd=BACKUP_DIR, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=120)
        if p.returncode != 0:
            raise RuntimeError("SHA256 backup Tala no pasó verificación")
    revision = command("docker", "image", "inspect", "--format",
                       '{{index .Config.Labels "org.opencontainers.image.revision"}}',
                       "talaeats-candidate:" + EXPECTED_SHA)
    if revision != EXPECTED_SHA:
        raise RuntimeError("Imagen candidata Tala Eats no coincide con GitHub")

def container_mounts(rows: list[dict]) -> tuple[set[str], set[pathlib.Path]]:
    volumes = set()
    hostpaths = set()
    for r in rows:
        raw = command("docker", "inspect", "--format", "{{json .Mounts}}", r["id"])
        mounts = json.loads(raw) or []
        for m in mounts:
            if m.get("Type") == "volume" and m.get("Name"):
                volumes.add(m["Name"])
            if m.get("Type") == "bind" and m.get("Source"):
                hostpaths.add(pathlib.Path(m["Source"]).resolve())
    return volumes, hostpaths

def candidates_directories() -> list[pathlib.Path]:
    out = []
    if not HOME.is_dir() or HOME.is_symlink() or HOME.resolve() != HOME:
        raise RuntimeError("HOME Kali inesperado")
    for child in HOME.iterdir():
        name = child.name
        if (name in DIR_EXACT or name.startswith(DIR_PREFIXES)):
            if child.is_symlink() or not child.is_dir():
                raise RuntimeError("Directorio externo no es un directorio normal: " + name)
            if child.resolve().parent != HOME or os.path.ismount(child):
                raise RuntimeError("Directorio externo apunta fuera o es mountpoint: " + name)
            out.append(child)
    return sorted(out)

def mountpoints() -> list[pathlib.Path]:
    # Reject deletions that contain any mounted filesystem beneath them.
    points = []
    with open("/proc/self/mountinfo", encoding="utf-8") as f:
        for line in f:
            parts = line.split()
            if len(parts) > 4:
                # Linux mountpoint field uses octal encoding for whitespace.
                raw = re.sub(r"\\([0-7]{3})",
                             lambda m: chr(int(m.group(1), 8)), parts[4])
                points.append(pathlib.Path(raw))
    return points

def safe_directories(dirs: list[pathlib.Path], protected_binds: set[pathlib.Path],
                     allmounts: list[pathlib.Path]) -> list[pathlib.Path]:
    for target in dirs:
        if target.parent != HOME or target.is_symlink() or not target.is_dir():
            raise RuntimeError("Directorio no autorizado: " + str(target))
        for p in protected_binds | set(allmounts):
            if p == target or target in p.parents or p in target.parents and p != HOME:
                # Catch folders hosting any other bind mounts, especially TALA.
                # Parent mountpoints / and /home are not relevant here.
                if p == target or target in p.parents:
                    raise RuntimeError("Un montaje protegido usa este directorio: " + str(target))
    return dirs

def image_references() -> list[str]:
    images = []
    raw = command("docker", "image", "ls", "--format", "{{json .}}")
    for row in raw.splitlines():
        info = json.loads(row)
        name = info.get("Repository", "")
        tag = info.get("Tag", "")
        if name.startswith(IMAGE_PREFIXES) and tag not in ("", "<none>"):
            images.append(name + ":" + tag)
    return sorted(set(images))

def selftest() -> None:
    assert all(not n.startswith("talaeats-") for n in VOLUMES)
    assert all(not n.startswith("talaeats-") for n in NETWORKS)
    assert all(not n.startswith("talaeats-") for n in DIR_EXACT)
    assert all(not n.startswith("talaeats-") for n in DIR_PREFIXES)
    assert all(not n.startswith("talaeats-") for n in IMAGE_PREFIXES)
    assert KEEP_PROJECTS.isdisjoint(REMOVE_PROJECTS)
    assert CONFIRM == "BORRAR_SOLO_DATOS_NO_TALA"
    print("TALA_ONLY_STORAGE_GUARDS_SELFTEST_PASS")

def main() -> None:
    parser = argparse.ArgumentParser()
    g = parser.add_mutually_exclusive_group(required=True)
    g.add_argument("--self-test", action="store_true")
    g.add_argument("--plan", action="store_true")
    g.add_argument("--delete", action="store_true")
    parser.add_argument("--confirm", default="")
    args = parser.parse_args()
    if args.self_test:
        selftest()
        return
    if args.delete and args.confirm != CONFIRM:
        raise RuntimeError("Falta confirmación exacta para eliminación de datos")

    rows = container_inventory()
    verify_green_and_backup(rows)
    used_volumes, used_binds = container_mounts(rows)
    selected_volumes = sorted(VOLUMES & docker_list("volume"))
    if set(selected_volumes) & used_volumes:
        raise RuntimeError("Un volumen a borrar sigue siendo usado por un contenedor")
    selected_networks = sorted(NETWORKS & docker_list("network"))
    selected_dirs = safe_directories(candidates_directories(), used_binds, mountpoints())
    selected_images = image_references()

    print("=== LIMPIEZA SOLO DE RECURSOS AJENOS ===")
    for name in selected_volumes:
        print("VOLUME " + name)
    for name in selected_networks:
        print("NETWORK " + name)
    for ref in selected_images:
        print("IMAGE " + ref)
    for path in selected_dirs:
        print("DIRECTORY " + str(path))
    print("PROTEGIDOS: TALA green/v3/admin, backups Tala, Docker/SSH/Cloudflared/Caddy")
    print("NO TOCAR: volúmenes anónimos o recursos sin identificar")
    print(f"TARGETS volumes={len(selected_volumes)} networks={len(selected_networks)}"
          f" images={len(selected_images)} dirs={len(selected_dirs)}")
    if args.plan:
        print("TALA_ONLY_STORAGE_PLAN_PASS — SIN BORRADOS")
        return

    failed = []
    for name in selected_volumes:
        if try_command("docker", "volume", "rm", name):
            print("REMOVED_VOLUME " + name)
        else:
            failed.append("volume:" + name)
    for name in selected_networks:
        if try_command("docker", "network", "rm", name):
            print("REMOVED_NETWORK " + name)
        else:
            failed.append("network:" + name)
    # Do not force image removal; Docker refuses image if in use by any container.
    for ref in selected_images:
        if try_command("docker", "image", "rm", ref):
            print("REMOVED_IMAGE " + ref)
        else:
            failed.append("image:" + ref)
    for target in selected_dirs:
        # Check again just before irreversible removal.
        if target.is_symlink() or not target.is_dir() or target.parent != HOME:
            failed.append("dir:" + str(target))
            continue
        try:
            safe_directories([target], used_binds, mountpoints())
            shutil.rmtree(target)
            print("REMOVED_DIRECTORY " + target.name)
        except (OSError, RuntimeError):
            failed.append("dir:" + str(target))

    try:
        verify_green_and_backup(container_inventory())
        print("TALA_GREEN_READY_AFTER_CLEANUP_PASS")
    except RuntimeError:
        print("WARNING: verificar backend green manualmente; limpieza ya aplicada",
              file=sys.stderr)
        raise
    if failed:
        print("PENDIENTES: " + ", ".join(failed), file=sys.stderr)
        raise RuntimeError("Algunos elementos se conservaron por seguridad")
    print("TALA_ONLY_STORAGE_CLEANUP_PASS")
    print("Sin borrar volúmenes anónimos ni archivos de ubicación desconocida.")

if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as ex:
        print("TALA_ONLY_STORAGE_ABORTED: " + str(ex), file=sys.stderr)
        sys.exit(2)
