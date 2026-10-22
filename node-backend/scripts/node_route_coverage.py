#!/usr/bin/env python3
"""Conservative structural coverage: Python 252 FastAPI vs Node Express declarations.

This does NOT equate any matching route with functional parity. It is a
machine-readable inventory of mounted endpoints only, not parity of RBAC,
JSON, side effects, ledger, websocket, workers, Flutter contracts or SLO.
No environment variables, network access, JS execution, production imports
or database connections are required.
"""
from __future__ import annotations
import argparse
import json
import re
from pathlib import Path
from python_route_inventory import inventory, check

ROOT = Path(__file__).resolve().parents[2]
NODE_ROUTERS = {
    "authRouter": (ROOT / "node-backend/src/auth/routes.ts", "/api/v1/auth"),
    "marketplaceRouter": (ROOT / "node-backend/src/marketplace/routes.ts", "/api/v1/restaurants"),
    "ownerRouter": (ROOT / "node-backend/src/marketplace/routes.ts", "/api/v1/owner"),
    "stageOrdersRouter": (ROOT / "node-backend/src/marketplace/routes.ts", "/api/v1/orders"),
    "stageDriverRouter": (ROOT / "node-backend/src/marketplace/routes.ts", "/api/v1/driver"),
    "platformRouter": (ROOT / "node-backend/src/platform/routes.ts", "/api/v1/platform"),
    "adminRouter": (ROOT / "node-backend/src/operational/routes.ts", "/api/v1/admin"),
    "operationsRouter": (ROOT / "node-backend/src/operational/routes.ts", "/api/v1/operations"),
    "v9Router": (ROOT / "node-backend/src/versions/routes.ts", "/api/v1/v9"),
    "v10Router": (ROOT / "node-backend/src/versions/routes.ts", "/api/v1/v10"),
    "v11Router": (ROOT / "node-backend/src/versions/routes.ts", "/api/v1/v11"),
    "resilienceRouter": (ROOT / "node-backend/src/resilience/routes.ts", "/api/v1/resilience"),
    "parityRouter": (ROOT / "node-backend/src/parity/routes.ts", "/api/v1"),
}
ROUTE_RE = re.compile(
    r"""\b(?P<router>authRouter|marketplaceRouter|ownerRouter|stageOrdersRouter|stageDriverRouter|platformRouter|adminRouter|operationsRouter|v9Router|v10Router|v11Router|resilienceRouter|parityRouter)"""
    r"""\.(?P<method>get|post|put|patch|delete|head|options)"""
    r"""\(\s*['"](?P<path>/[^'"]*)['"]""",
    re.MULTILINE,
)

def canonical(verb: str, path: str) -> tuple[str, str]:
    parts = []
    for part in path.strip("/").split("/"):
        if part.startswith(":") or (part.startswith("{") and part.endswith("}")):
            parts.append("{}")
        elif part:
            parts.append(part)
    return (verb.upper(), "/" + "/".join(parts))

def node_routes() -> list[dict[str, str]]:
    files = sorted({file for file, _ in NODE_ROUTERS.values()})
    parsed = []
    for file in files:
        source = file.read_text(encoding="utf-8")
        for match in ROUTE_RE.finditer(source):
            router = match.group("router")
            mounted, base = NODE_ROUTERS[router]
            if file != mounted:
                raise ValueError(f"Node router {router} found outside its mount: {file}")
            subpath = match.group("path")
            parsed.append({"method":match.group("method").upper(),
                          "path":(base.rstrip("/") + subpath).rstrip("/"),
                          "source":str(file.relative_to(ROOT)), "router":router})
    return parsed

def report() -> dict[str, object]:
    python = inventory()
    check(python)
    node = node_routes()
    python_keys = {canonical(r["method"], r["path"]):r for r in python}
    node_keys: set[tuple[str, str]] = set()
    implemented = []
    extra = []
    for n in node:
        key = canonical(n["method"], n["path"])
        if key in node_keys:
            raise ValueError(f"Duplicate Node mounted route declaration: {key}")
        node_keys.add(key)
        record = dict(n)
        if key in python_keys:
            record["python_module"] = python_keys[key]["module"]
            implemented.append(record)
        else:
            extra.append(record)
    missed = [r for r in python if canonical(r["method"],r["path"]) not in node_keys]
    groups = {}
    for item in python:
        module=item["module"]
        groups.setdefault(module, {"python":0, "node_declared":0})
        groups[module]["python"]+=1
    for item in implemented:
        groups[item["python_module"]]["node_declared"]+=1
    return {
        "python_http_routes":len(python),
        "node_express_declarations":len(node),
        "structural_matches":len(implemented),
        "python_routes_without_node_declaration":len(missed),
        "node_routes_without_python_match":extra,
        "per_python_module":dict(sorted(groups.items())),
        "matched":implemented,
        "not_declared":missed,
        "warning":"Structural route matching ONLY; includes intentional 503 stubs "
                  "and stage-only features. Not a functional completion percentage.",
    }

# Explicitly approved Node-only administrative contracts. This allowlist
# does not turn route-signature coverage into evidence of working endpoints.
# All four operations have separate RBAC/TOTP and transactional E2E gates.
ADMIN_NODE_ONLY = {
    ("GET", "/api/v1/admin/support"),
    ("PATCH", "/api/v1/admin/support/{}"),
    ("GET", "/api/v1/admin/restaurants"),
    ("PATCH", "/api/v1/admin/restaurants/{}/archive"),
}

def main() -> None:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check",action="store_true")
    parser.add_argument("--json",action="store_true")
    args=parser.parse_args()
    data=report()
    if args.check:
        observed = {canonical(x["method"], x["path"])
                    for x in data["node_routes_without_python_match"]}
        if observed != ADMIN_NODE_ONLY:
            raise ValueError("Unapproved Node-only route delta: "+
                             json.dumps(data["node_routes_without_python_match"]))
    if args.json:
        print(json.dumps(data,indent=2,ensure_ascii=False))
    else:
        print(f"PYTHON_HTTP_ROUTES={data['python_http_routes']}")
        print(f"NODE_EXPRESS_DECLARATIONS={data['node_express_declarations']}")
        print(f"NODE_PYTHON_STRUCTURAL_MATCHES={data['structural_matches']}")
        print(f"PYTHON_ROUTES_NO_NODE_DECLARATION={data['python_routes_without_node_declaration']}")
        print("NOT_FUNCTIONAL_PARITY_PERCENTAGE=TRUE")
        if args.check:
            print("NODE_PYTHON_STATIC_ROUTE_MATCH=PASS")

if __name__=="__main__":
    main()
