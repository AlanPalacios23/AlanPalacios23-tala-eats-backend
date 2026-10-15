#!/usr/bin/env python3
"""F1.03: read-only Kali proxy diagnostics with deliberately minimal output.

Uses Docker metadata from exact Tala Eats containers; NEVER reads .env,
secrets, logs, request bodies, Caddyfile or payment data. Optional GETs
query readiness without credentials. No Docker writes, reloads or restarts.
This preflight alone cannot certify Caddy/Cloudflare header sanitation.
"""
from __future__ import annotations

import argparse
import json
import subprocess
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

PROJECT = "talaeats-v3"
BACKEND = PROJECT + "-backend-1"
CADDY = PROJECT + "-caddy-1"
READY_URL = "https://talaeats.alan-palacios-dev.com/api/v1/ready"


def _read(args: list[str], *, timeout: int = 12) -> str:
    try:
        result = subprocess.run(
            args, capture_output=True, text=True, check=False, timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("No disponible el diagnóstico de Docker") from exc
    if result.returncode:
        # The Docker error stream is deliberately discarded.
        raise RuntimeError("No se pudo leer el estado de Docker")
    return result.stdout.strip()


def _inspect_json(container: str, template: str):
    if container not in {BACKEND, CADDY}:
        raise RuntimeError("Contenedor no permitido")
    return json.loads(_read([
        "docker", "inspect", "--type", "container", "--format",
        template, container,
    ]))


def _network_names(networks: dict) -> set[str]:
    return set(networks) if isinstance(networks, dict) else set()


def _public_bindings(bindings: dict | None) -> bool:
    """True when backend binds to a non-loopback host interface."""
    for entries in (bindings or {}).values():
        for entry in entries or []:
            ip = (entry.get("HostIp") or "").strip()
            if ip not in {"127.0.0.1", "::1"}:
                return True
    return False


def _ready_snapshot(status: int | None, document) -> dict:
    healthy = (
        status == 200
        and isinstance(document, dict)
        and document.get("ready") is True
        and document.get("database") is True
        and document.get("redis") is True
    )
    return {"http_code": status, "json_ready_db_redis": bool(healthy)}


def _public_ready() -> dict:
    request = Request(READY_URL, headers={
        "User-Agent": "TalaEats-Readonly-Release-Preflight/1.0",
        "Accept": "application/json",
    })
    try:
        with urlopen(request, timeout=9) as response:
            raw = response.read(4096)
            try:
                payload = json.loads(raw)
            except (ValueError, UnicodeError):
                payload = {}
            return _ready_snapshot(response.status, payload)
    except HTTPError as exc:
        return _ready_snapshot(exc.code, {})
    except (URLError, TimeoutError, OSError, ValueError):
        return _ready_snapshot(None, {})


def _origin_ready() -> dict:
    # Only executes one GET against the backend's own loopback inside its
    # existing container; no shell, env inspection, migrations or state writes.
    code = (
        "import json\n"
        "from urllib.request import urlopen\n"
        "from urllib.error import HTTPError, URLError\n"
        "try:\n"
        "  with urlopen('http://127.0.0.1:8000/api/v1/ready',timeout=6) as r:\n"
        "    value=json.loads(r.read(4096))\n"
        "    print(json.dumps({'http_code':r.status,'ready':value.get('ready'),"
        "'database':value.get('database'),'redis':value.get('redis')}))\n"
        "except HTTPError as e:\n"
        "  print(json.dumps({'http_code':e.code}))\n"
        "except (URLError,OSError,ValueError):\n"
        "  print(json.dumps({'http_code':None}))\n"
    )
    try:
        raw = _read(["docker", "exec", BACKEND, "python", "-c", code], timeout=10)
        data = json.loads(raw)
        return _ready_snapshot(data.get("http_code"), data)
    except (RuntimeError, ValueError, KeyError, TypeError):
        return _ready_snapshot(None, {})


def _docker_status(container: str) -> bool:
    state = _inspect_json(container, "{{json .State.Status}}")
    return state == "running"


def collect() -> dict:
    # Compose labels permit rejecting unrelated containers on Kali.
    for name, service in ((BACKEND, "backend"), (CADDY, "caddy")):
        labels = _inspect_json(name, "{{json .Config.Labels}}")
        if (
            not isinstance(labels, dict)
            or labels.get("com.docker.compose.project") != PROJECT
            or labels.get("com.docker.compose.service") != service
        ):
            raise RuntimeError("Etiquetas Compose no coinciden con Tala Eats")
    back = _inspect_json(BACKEND, "{{json .NetworkSettings.Networks}}")
    caddy = _inspect_json(CADDY, "{{json .NetworkSettings.Networks}}")
    port_bindings = _inspect_json(BACKEND, "{{json .HostConfig.PortBindings}}")
    return {
        "project": PROJECT,
        "backend_running": _docker_status(BACKEND),
        "caddy_running": _docker_status(CADDY),
        "backend_and_caddy_share_docker_network": bool(
            _network_names(back) & _network_names(caddy)
        ),
        "backend_not_publicly_port_bound": not _public_bindings(port_bindings),
        "backend_origin_ready": _origin_ready(),
        "external_ready_from_kali": _public_ready(),
        "caddy_cleans_untrusted_forwarded_headers": "NOT_VERIFIED",
        "uvicorn_actual_peer_allowlist": "NOT_VERIFIED",
        "cloudflare_waf_tunnel_events": "NOT_VERIFIED",
        "f103_operational_pass": False,
        "notes": (
            "Preflight is read-only. Inspect actual Caddyfile and Uvicorn "
            "allowlist privately, diagnose prior external HTTP 403 in "
            "Cloudflare WAF/Tunnel, and verify trusted-proxy identity "
            "before approving production."
        ),
    }


def self_test() -> None:
    assert _network_names({"private": {}, "admin": {}}) == {"private", "admin"}
    assert _network_names(None) == set()
    assert not _public_bindings(None)
    assert not _public_bindings({"8000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "18000"}]})
    assert _public_bindings({"8000/tcp": [{"HostIp": "", "HostPort": "8000"}]})
    assert _public_bindings({"8000/tcp": [{"HostIp": "0.0.0.0", "HostPort": "8000"}]})
    assert _public_bindings({"8000/tcp": [{"HostIp": "::", "HostPort": "8000"}]})
    assert _ready_snapshot(200, {"ready": True, "database": True, "redis": True})[
        "json_ready_db_redis"
    ]
    assert not _ready_snapshot(403, {"ready": True, "database": True, "redis": True})[
        "json_ready_db_redis"
    ]
    assert not _ready_snapshot(200, {"ready": False, "database": True, "redis": True})[
        "json_ready_db_redis"
    ]
    # Report builder never returns Compose environment, IPs or secret values.
    sample = {
        "network_ip": "172.100.15.7",
        "STRIPE_SECRET_KEY": "DO_NOT_LEAK_SECRET",
    }
    assert "DO_NOT_LEAK_SECRET" not in json.dumps(_network_names(sample), default=list)
    print("F103_KALI_PROXY_READONLY_SELFTEST_PASS")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    try:
        print(json.dumps(collect(), indent=2, ensure_ascii=False))
    except (RuntimeError, ValueError, KeyError, TypeError) as exc:
        print("F103_KALI_PROXY_READONLY_FAIL: metadatos Docker no disponibles")
        return 2
    print("F103_KALI_PROXY_READONLY_PARTIAL_EVIDENCE")
    print("Caddy/Cloudflare trust requires manual authorization: NOT PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
