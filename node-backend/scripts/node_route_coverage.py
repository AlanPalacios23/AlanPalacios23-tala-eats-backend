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
# New RC7 read-only, buyer-authenticated server-authoritative payment status.
# Source checks also require owner match, immutable ledger and no secret leaks.
STRIPE_TEST_STATUS_NODE_ONLY = {
    ("GET", "/api/v1/payments/stripe/orders/{}/status"),
}
# RC8.6 non-binding, customer-authenticated pickup catalog price preview.
# No delivery quote, order reservation, card charge or financial writes.
PICKUP_PRICE_PREVIEW_NODE_ONLY = {
    ("POST", "/api/v1/orders/quote"),
}
# RC8.7: stage-only, authenticated, cash-only and nonbinding geodistance preview.
STAGE_DELIVERY_QUOTE_NODE_ONLY = {
    ("POST", "/api/v1/orders/delivery-quote"),
}
# RC9.4 backend-hosted recovery fallback for all three Flutter roles. This
# interface does not replace the JSON reset contract; it is an explicit,
# unauthenticated, capability-token HTML form for users without App Links.
PASSWORD_RESET_BROWSER_NODE_ONLY = {
    ("GET", "/api/v1/auth/password/reset-page"),
    ("POST", "/api/v1/auth/password/reset-page"),
}

# RC9.5: authenticated driver-only presence inspection (no coordinates,
# merchant identity, order writes, checkout, or dispatch authorization).
RC95_DRIVER_READINESS_NODE_ONLY = {
    ("GET", "/api/v1/driver/presence-readiness"),
}

# RC11.0: production driver registration READ-ONLY compatibility handshake.
# The endpoint checks the real LIVE DB schema before claiming support; it
# returns 503 when the migration is missing. It cannot approve a driver or
# bypass the authenticated ADMIN decision.
RC110_ONBOARDING_CAPABILITIES_NODE_ONLY = {
    ("GET", "/api/v1/operations/onboarding-capabilities"),
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
        if observed != (ADMIN_NODE_ONLY | STRIPE_TEST_STATUS_NODE_ONLY |
                        PICKUP_PRICE_PREVIEW_NODE_ONLY | STAGE_DELIVERY_QUOTE_NODE_ONLY |
                        PASSWORD_RESET_BROWSER_NODE_ONLY |
                        RC95_DRIVER_READINESS_NODE_ONLY |
                         RC110_ONBOARDING_CAPABILITIES_NODE_ONLY):
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
