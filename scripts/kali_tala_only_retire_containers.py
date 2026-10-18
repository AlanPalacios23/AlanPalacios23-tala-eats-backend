#!/usr/bin/env python3
"""Conservative Kali non-Tala Eats container retirement, from verified inventory.

Modes:
  --plan                         read-only inventory and GO/NO-GO
  --retire --confirm ...         remove only specifically approved non-Tala containers

No Docker Compose teardown, no image/volume/network pruning, no file deletion.
Keep ALL Tala Eats projects, cloudflared, Caddy, host services, rollback images,
media and encrypted backups.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from urllib.error import URLError, HTTPError
from urllib.request import urlopen

REMOVE_PROJECTS = frozenset({
    "codexia-web-beta",
    "control_inventario_servidor_interno",
    "dateclub-v400-staging",
    "deploy",  # Found in inventory: Sentinel backend, frontend and PostgreSQL
    "noctra-store-v022-server",
    "psico-whatsapp-bot-v01",
})
KEEP_PROJECTS = frozenset({"talaeats-v3", "talaeats-admin", "talaeats-green"})
GREEN = {
    "talaeats-green-api-1",
    "talaeats-green-worker-1",
    "talaeats-green-db-1",
    "talaeats-green-redis-1",
}
CONFIRM = "RETIRAR_SOLO_CONTENEDORES_AJENOS_A_TALA"

def run(*argv: str) -> str:
    result = subprocess.run(argv, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, timeout=90)
    if result.returncode:
        # Docker stderr can contain sensitive values. Do not emit raw output.
        raise RuntimeError("Comando Docker falló: " + " ".join(argv[:2]))
    return result.stdout.strip()

def inventory() -> list[dict[str, str]]:
    rows = run("docker", "ps", "-a", "--format",
               '{{.ID}}|{{.Names}}|{{.Label "com.docker.compose.project"}}|{{.Status}}')
    out = []
    for line in rows.splitlines():
        fields = line.split("|", 3)
        if len(fields) != 4:
            raise RuntimeError("Inventario Docker desconocido; no retirar")
        cid, name, project, status = fields
        out.append(dict(id=cid, name=name, project=project, status=status))
    return out

def classify(rows: list[dict[str, str]]) -> tuple[list[dict[str, str]],list[dict[str,str]],list[dict[str,str]]]:
    removable, kept, unknown = [], [], []
    for row in rows:
        project, name = row["project"], row["name"]
        if project in KEEP_PROJECTS or name.startswith("talaeats-"):
            if project in REMOVE_PROJECTS:
                raise RuntimeError("Conflicto de etiqueta con TALA EATS; cancelado")
            kept.append(row)
        elif project in REMOVE_PROJECTS:
            removable.append(row)
        else:
            unknown.append(row)
    return removable, kept, unknown

def green_ready(rows: list[dict[str, str]]) -> bool:
    byname = {c["name"]: c for c in rows}
    if not all(byname.get(n, {}).get("project") == "talaeats-green" for n in GREEN):
        return False
    if not all(byname[n]["status"].startswith("Up ") for n in GREEN):
        return False
    try:
        with urlopen("http://127.0.0.1:18182/api/v1/ready", timeout=8) as res:
            payload = json.load(res)
        return (payload.get("ready") is True
                and payload.get("database") is True
                and payload.get("redis") is True
                and payload.get("version") == "1.6.4-connect-selfservice-hf1")
    except (OSError, URLError, HTTPError, ValueError):
        return False

def selftest() -> None:
    r = [
        {"id":"1","name":"talaeats-green-db-1","project":"talaeats-green","status":"Up 2 hours"},
        {"id":"2","name":"codexia-web-beta-db-1","project":"codexia-web-beta","status":"Up 2 hours"},
        {"id":"3","name":"talaeats-v3-backend-1","project":"talaeats-v3","status":"Restarting"},
        {"id":"4","name":"talaeats-admin-web","project":"talaeats-admin","status":"Up 2 hours"},
        {"id":"5","name":"determined_bose","project":"","status":"Exited"},
    ]
    rem, keep, other = classify(r)
    assert [e["id"] for e in rem] == ["2"]
    assert {e["id"] for e in keep} == {"1","3","4"}
    assert [e["id"] for e in other] == ["5"]
    try:
        classify([{"id":"a","name":"talaeats-important","project":"deploy","status":"Up"}])
    except RuntimeError:
        pass
    else:
        raise AssertionError("Accepted Tala container with non-Tala project label")
    assert all(x not in REMOVE_PROJECTS for x in KEEP_PROJECTS)
    print("TALA_ONLY_RETIRE_SELFTEST_PASS")

def main() -> None:
    parser = argparse.ArgumentParser()
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--plan", action="store_true")
    action.add_argument("--retire", action="store_true")
    action.add_argument("--self-test", action="store_true")
    parser.add_argument("--confirm", default="")
    args = parser.parse_args()

    if args.self_test:
        selftest()
        return
    rows = inventory()
    targets, kept, unknown = classify(rows)
    print("=== PROYECTOS TALA EATS QUE SE CONSERVARAN ===")
    for row in kept:
        print(f"KEEP {row['project']} / {row['name']} [{row['status']}]")
    print("=== CONTENEDORES AJENOS QUE SE RETIRARAN ===")
    for row in targets:
        print(f"RETIRE {row['project']} / {row['name']} [{row['status']}]")
    print("=== FUERA DE ALCANCE (NO SE RETIRARAN) ===")
    for row in unknown:
        print(f"SKIP {row['project'] or '<sin proyecto>'} / {row['name']}")
    ok = green_ready(rows)
    print("GREEN_LOCAL_READY_" + ("PASS" if ok else "FAIL"))
    print(f"RETIRE_TARGET_COUNT={len(targets)}")

    if args.plan:
        print("TALA_ONLY_CLEANUP_PLAN_PASS — sin cambios")
        return
    if args.confirm != CONFIRM:
        raise RuntimeError("Falta frase exacta de confirmación; sin cambios")
    if not ok:
        raise RuntimeError("GREEN no está saludable; prohibido desconectar otros proyectos")
    if any(row["name"] not in {"determined_bose"} and row["status"].startswith("Up ")
           for row in unknown):
        raise RuntimeError("Hay contenedores activos no clasificados: revisar antes de retirar")
    # No data deletion. Only remove the exact listed containers, preserving volumes/images.
    failed = []
    for row in targets:
        try:
            # Revalidate service and project immediately before removal.
            label = run("docker", "inspect", "--format",
                        '{{index .Config.Labels "com.docker.compose.project"}}', row["id"])
            if label != row["project"] or label not in REMOVE_PROJECTS:
                raise RuntimeError("Etiqueta del contenedor cambió")
            run("docker", "rm", "-f", row["id"])
            print("REMOVED_CONTAINER " + row["name"])
        except (RuntimeError, subprocess.TimeoutExpired) as exc:
            failed.append(row["name"])
            print("FAILED_CONTAINER " + row["name"])
    if failed:
        raise RuntimeError("Algunos contenedores no pudieron retirarse; consultar inventario")
    after, still_keep, _ = classify(inventory())
    if after:
        raise RuntimeError("Todavía quedan contenedores objetivo; consultar estado")
    if not green_ready(inventory()):
        raise RuntimeError("ATENCION: GREEN dejó de responder tras limpieza; revisar red/servicios")
    print("TALA_ONLY_NON_TALA_CONTAINERS_REMOVED_PASS")
    print("TALA EATS green/v3/admin + bases y backups intactos.")
    print("Aún no se borraron volúmenes, imágenes ni código de otros proyectos.")

if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as exc:
        print("TALA_ONLY_RETIRE_ABORTED: " + str(exc), file=sys.stderr)
        sys.exit(2)
