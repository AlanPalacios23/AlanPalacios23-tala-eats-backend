#!/usr/bin/env python3
"""Diagnóstico Compose limitado a metadatos permitidos (NO deploy, NO secretos)."""
import argparse
import json
import subprocess
from pathlib import Path

PROJECT = "talaeats-v3"
SERVICES = ("backend", "worker", "db", "redis", "frontend", "caddy")


def read_output(args, cwd=None):
    try:
        proc = subprocess.run(
            args, cwd=cwd, capture_output=True, text=True, timeout=40, check=False
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("Comando de inspección no disponible o agotó tiempo") from exc
    if proc.returncode:
        # NO imprimir stderr de Docker/Compose: podría incluir interpolación/configuración.
        raise RuntimeError("Falló una operación de SOLO LECTURA: " + " ".join(args[:2]))
    return proc.stdout.strip()


def inspect_piece(name, template):
    return read_output(["docker", "inspect", "--type", "container",
                        "--format", template, name])


def runtime_info(service):
    name = f"{PROJECT}-{service}-1"
    labels = json.loads(inspect_piece(name, "{{json .Config.Labels}}"))
    if labels.get("com.docker.compose.project") != PROJECT:
        raise RuntimeError(f"Proyecto inesperado: {service}")
    if labels.get("com.docker.compose.service") != service:
        raise RuntimeError(f"Servicio inesperado: {service}")
    data = {
        "service": service,
        "container": name,
        "image_tag": inspect_piece(name, "{{.Config.Image}}"),
        "image_id": inspect_piece(name, "{{.Image}}"),
        "state": inspect_piece(name, "{{.State.Status}}"),
        "health": inspect_piece(name, '{{if .State.Health}}{{.State.Health.Status}}{{else}}sin-healthcheck{{end}}'),
    }
    mounts = json.loads(inspect_piece(name, "{{json .Mounts}}"))
    data["mounts"] = [
        {"type": item.get("Type"), "name": item.get("Name") if item.get("Type") == "volume" else None,
         "target": item.get("Destination")}
        for item in mounts
    ]
    return data, labels


def summarize_service(info):
    """Deniega por diseño environment, secrets, build args y contenido de comandos."""
    build = info.get("build") or {}
    if isinstance(build, str):
        build = {"context": build}
    networks = info.get("networks") or {}
    return {
        "image": info.get("image"),
        "build_context": build.get("context") if isinstance(build, dict) else None,
        "dockerfile": build.get("dockerfile", "Dockerfile") if build else None,
        "has_build": bool(build),
        "custom_command": "command" in info,
        "custom_entrypoint": "entrypoint" in info,
        "depends_on_services": sorted((info.get("depends_on") or {}).keys())
            if isinstance(info.get("depends_on") or {}, dict)
            else sorted(info.get("depends_on") or []),
        "networks": sorted(networks.keys()) if isinstance(networks, dict) else sorted(networks),
        "has_env_file": bool(info.get("env_file")),
        "has_healthcheck": bool(info.get("healthcheck")),
        "volume_targets": [
            str(v.get("target")) for v in info.get("volumes", []) if isinstance(v, dict)
        ],
    }


def self_test():
    sentinel = "DO_NOT_LEAK_SECRET"
    sample = {
        "image": "talaeats-v3-backend",
        "build": {"context": "/safe/backend", "args": {"PASSWORD": sentinel}},
        "environment": {"STRIPE_SECRET_KEY": sentinel},
        "command": ["sh", "-c", sentinel],
        "secrets": [{"source": sentinel}],
        "volumes": [{"type": "volume", "source": "media", "target": "/app/media"}],
        "depends_on": {"db": {"condition": "service_healthy"}},
        "networks": {"private": None},
    }
    out = json.dumps(summarize_service(sample))
    assert sentinel not in out
    assert "STRIPE_SECRET_KEY" not in out
    assert '"command":' not in out
    assert '"source":' not in out
    assert "db" in out and "/app/media" in out
    print("COMPOSE_TOPOLOGY_SANITIZER_SELFTEST_PASS")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return

    live = {}
    labels_by_service = {}
    for service in SERVICES:
        live[service], labels_by_service[service] = runtime_info(service)
    api = live["backend"]
    if api["state"] != "running" or api["health"] != "healthy":
        raise RuntimeError("El backend no está healthy: no continuar")
    if live["db"]["health"] != "healthy" or live["redis"]["health"] != "healthy":
        raise RuntimeError("PostgreSQL/Redis no están healthy: no continuar")

    labels = labels_by_service["backend"]
    working_dir = labels.get("com.docker.compose.project.working_dir")
    config_files = labels.get("com.docker.compose.project.config_files", "")
    if not working_dir or not config_files:
        raise RuntimeError("No se encontraron las rutas de Compose en Docker")
    working_path = Path(working_dir).resolve()
    if not str(working_path).startswith("/home/alan/talaeats-releases/"):
        raise RuntimeError("El directorio Compose no está en la ruta de releases aprobada")
    compose_files = [Path(p.strip()) for p in config_files.split(",") if p.strip()]
    if not compose_files or not all(p.is_file() for p in compose_files):
        raise RuntimeError("Falta al menos un fichero Compose")
    cmd = ["docker", "compose", "-p", PROJECT, "--project-directory", str(working_path)]
    for path in compose_files:
        cmd.extend(["-f", str(path)])
    cmd.extend(["config", "--format", "json"])
    resolved = json.loads(read_output(cmd, cwd=str(working_path)))
    compose_services = resolved.get("services") or {}
    if not set(SERVICES).issubset(compose_services):
        raise RuntimeError("La configuración Compose no tiene los seis servicios esperados")
    if resolved.get("name") and resolved["name"] != PROJECT:
        raise RuntimeError("Compose resolvió un nombre de proyecto distinto")

    report = {
        "project": PROJECT,
        "compose_directory": str(working_path),
        "compose_files": [str(x) for x in compose_files],
        "compose": {s: summarize_service(compose_services[s]) for s in SERVICES},
        "runtime": live,
        "guarantee": "Solo lectura; salida limitada a campos permitidos; ninguna credencial/valor de entorno",
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))
    print("COMPOSE_TOPOLOGY_READONLY_PASS")
    print("No ha ocurrido build, reinicio, deploy, backup ni rollback.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, KeyError, json.JSONDecodeError) as exc:
        # No exponer excepciones originadas desde un JSON sensible de Compose.
        print("COMPOSE_TOPOLOGY_READONLY_FAIL:", str(exc))
        raise SystemExit(2)
