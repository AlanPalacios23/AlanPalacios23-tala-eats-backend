#!/usr/bin/env python3
"""Static FastAPI route inventory for the Python -> Node migration.

Reads source files as AST: never imports the production app, connects to
databases, reads .env files, or invokes external services. The 252-route
baseline is from Python main@7cf8ae3f4fce51b1265ad511bd4e36077fc42636.
This verifies inventory integrity, NOT runtime parity or production readiness.
"""
from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path

EXPECTED = {
    "admin": 13,
    "auth": 12,
    "driver": 9,
    "operations": 38,
    "orders": 8,
    "owner": 12,
    "payments": 4,
    "platform": 27,
    "resilience": 11,
    "restaurants": 2,
    "stripe_payments": 7,
    "uploads": 9,
    "v10": 3,
    "v11": 28,
    "v9": 62,
    "withdrawals": 7,
}
METHODS = {"get", "post", "put", "patch", "delete", "head", "options"}
SOURCE_DIR = Path(__file__).resolve().parents[2] / "backend" / "app" / "routes"


def route_prefix(tree: ast.Module, source: Path) -> str:
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if not any(isinstance(t, ast.Name) and t.id == "router" for t in node.targets):
            continue
        call = node.value
        if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name) or call.func.id != "APIRouter":
            continue
        for arg in call.keywords:
            if arg.arg == "prefix" and isinstance(arg.value, ast.Constant) and isinstance(arg.value.value, str):
                return arg.value.value
    raise ValueError(f"No static APIRouter(prefix=...) in {source}")


def inventory(source_dir: Path = SOURCE_DIR) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    paths = sorted(p for p in source_dir.glob("*.py") if p.name != "__init__.py")
    actual_modules = {p.stem for p in paths}
    if actual_modules != set(EXPECTED):
        raise ValueError(f"Python route modules changed: missing={sorted(set(EXPECTED)-actual_modules)} "
                         f"new={sorted(actual_modules-set(EXPECTED))}")
    for source in paths:
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        prefix = route_prefix(tree, source)
        for node in tree.body:
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for decorator in node.decorator_list:
                if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
                    continue
                target = decorator.func
                if not isinstance(target.value, ast.Name) or target.value.id != "router":
                    continue
                if target.attr not in METHODS:
                    raise ValueError(f"Unsupported router decorator {source.name}:{node.lineno}: {target.attr}")
                if not decorator.args or not isinstance(decorator.args[0], ast.Constant) or not isinstance(decorator.args[0].value, str):
                    raise ValueError(f"Nonliteral route {source.name}:{node.lineno}")
                subpath = decorator.args[0].value
                if subpath and not subpath.startswith("/"):
                    raise ValueError(f"Invalid path {source.name}:{node.lineno}: {subpath}")
                result.append({
                    "module": source.stem,
                    "method": target.attr.upper(),
                    "path": prefix + subpath,
                    "handler": node.name,
                })
    return sorted(result, key=lambda row: (row["module"], row["path"], row["method"]))


def check(routes: list[dict[str, str]]) -> None:
    by_module = {module: 0 for module in EXPECTED}
    seen: set[tuple[str, str]] = set()
    for row in routes:
        by_module[row["module"]] += 1
        key = (row["method"], row["path"])
        if key in seen:
            raise ValueError(f"Duplicate Python HTTP route: {key}")
        seen.add(key)
    mismatches = {m: {"expected": count, "actual": by_module[m]}
                  for m, count in EXPECTED.items() if by_module[m] != count}
    if mismatches or len(routes) != 252:
        raise ValueError(f"Python route contract drift: total={len(routes)}, modules={mismatches}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail on route count/drift")
    parser.add_argument("--json", action="store_true", help="Print machine-readable inventory")
    args = parser.parse_args()
    routes = inventory()
    if args.check:
        check(routes)
    if args.json:
        print(json.dumps({"count": len(routes), "routes": routes}, indent=2, ensure_ascii=False))
    else:
        print(f"PYTHON_HTTP_ROUTE_INVENTORY={len(routes)}")
        if args.check:
            print("PYTHON_252_ROUTE_BASELINE=PASS")
            print("STATIC_INVENTORY_ONLY_NOT_FUNCTIONAL_PARITY=TRUE")


if __name__ == "__main__":
    main()
