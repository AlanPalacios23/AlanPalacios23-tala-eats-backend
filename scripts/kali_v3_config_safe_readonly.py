#!/usr/bin/env python3
"""Kali V3 DB config consistency probe, READ ONLY.

Reads container environment in memory using docker inspect. NEVER displays
values, usernames, hostnames, passwords, SQL, raw logs or Docker env arrays.
It does not connect to PostgreSQL or alter containers.
"""
from __future__ import annotations
import json
import subprocess
from urllib.parse import urlsplit

BACKEND = "talaeats-v3-backend-1"
DB = "talaeats-v3-db-1"

def inspect_json(name: str, template: str):
    p = subprocess.run(["docker", "inspect", "--type", "container",
                        "--format", template, name],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       timeout=12, check=False)
    if p.returncode != 0:
        raise RuntimeError("Docker inspection unavailable")
    return json.loads(p.stdout)

def env_dict(items):
    result = {}
    for item in items if isinstance(items, list) else []:
        if isinstance(item, str) and "=" in item:
            key, value = item.split("=", 1)
            if key in {"DATABASE_URL", "ENVIRONMENT", "AUTO_MIGRATE_ON_START"}:
                result[key] = value
    return result

def aliases_on_shared_network(backend_networks, database_networks):
    shared = set(backend_networks) & set(database_networks)
    aliases = {"talaeats-v3-db-1"}
    for network in shared:
        data = database_networks.get(network) or {}
        aliases.update(str(s) for s in (data.get("Aliases") or []) if isinstance(s, str))
    return bool(shared), {name.lower() for name in aliases}

def evaluate(backend_env, backend_networks, db_networks):
    env = env_dict(backend_env)
    url = env.get("DATABASE_URL", "")
    shared, aliases = aliases_on_shared_network(backend_networks, db_networks)
    result = {
        "DATABASE_URL_PRESENT": "yes" if url else "no",
        "NETWORK_SHARED": "yes" if shared else "no",
        "ENVIRONMENT_PRODUCTION": "yes" if env.get("ENVIRONMENT", "").strip().lower() == "production" else "no-or-unset",
        "AUTO_MIGRATE_FLAG_ON": "yes" if env.get("AUTO_MIGRATE_ON_START", "").strip().lower() in {"true","1","yes","on"} else "no-or-unset",
    }
    if not url:
        result["DB_SCHEME_POSTGRES"] = "unknown"
        result["DB_HOST_MATCH_V3_DB_ALIAS"] = "unknown"
        result["DB_PORT_EXPECTED_5432"] = "unknown"
        return result
    try:
        parsed = urlsplit(url)
        result["DB_SCHEME_POSTGRES"] = "yes" if parsed.scheme.startswith("postgresql") else "no"
        host = (parsed.hostname or "").lower()
        result["DB_HOST_MATCH_V3_DB_ALIAS"] = "yes" if shared and host in aliases else ("unknown" if not shared else "no")
        result["DB_PORT_EXPECTED_5432"] = "yes" if parsed.port in (None, 5432) else "no"
    except (ValueError, AttributeError, TypeError):
        result["DB_SCHEME_POSTGRES"] = "invalid"
        result["DB_HOST_MATCH_V3_DB_ALIAS"] = "unknown"
        result["DB_PORT_EXPECTED_5432"] = "unknown"
    return result

def main():
    print("TALA_V3_CONFIG_SAFE_BEGIN")
    try:
        env = inspect_json(BACKEND, "{{json .Config.Env}}")
        backend_networks = inspect_json(BACKEND, "{{json .NetworkSettings.Networks}}")
        db_networks = inspect_json(DB, "{{json .NetworkSettings.Networks}}")
        result = evaluate(env, backend_networks, db_networks)
        for key in ("DATABASE_URL_PRESENT", "NETWORK_SHARED", "ENVIRONMENT_PRODUCTION",
                    "AUTO_MIGRATE_FLAG_ON", "DB_SCHEME_POSTGRES",
                    "DB_HOST_MATCH_V3_DB_ALIAS", "DB_PORT_EXPECTED_5432"):
            print("SAFE_CHECK", key, result[key])
    except (OSError, subprocess.TimeoutExpired, RuntimeError, ValueError, TypeError, KeyError):
        print("SAFE_CHECK INSPECTION_UNAVAILABLE")
    print("NO_ENV_VALUES_NO_SECRETS_NO_SQL_NO_CHANGES")
    print("TALA_V3_CONFIG_SAFE_END")

if __name__ == "__main__":
    main()
