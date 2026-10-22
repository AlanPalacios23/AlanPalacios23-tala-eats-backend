#!/usr/bin/env python3
"""Read-only Prisma migration inventory. No database access and no migration execution.

This is a static P0 safety gate, not proof of migration safety against existing
data. Always run Prisma migrate status and a restored-backup rehearsal on Kali.
"""
from __future__ import annotations
import argparse
import json
import re
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parents[1] / "prisma" / "migrations"
# Match actual destructive SQL statements, NOT FK clauses like ON DELETE CASCADE
# or words inside quoted PL/pgSQL exceptions.
DANGEROUS = (
    re.compile(r"^\s*DROP\s+(?:TABLE|SCHEMA|DATABASE|TYPE|INDEX)\b", re.I | re.M),
    re.compile(r"^\s*TRUNCATE\b", re.I | re.M),
    re.compile(r"^\s*DELETE\s+FROM\b", re.I | re.M),
    re.compile(r"^\s*UPDATE\s+[\w\.\"]+\s+SET\b", re.I | re.M),
    re.compile(r"^\s*ALTER\s+TABLE\b[^;]*\bDROP\s+COLUMN\b", re.I | re.M | re.S),
    re.compile(r"^\s*ALTER\s+TABLE\b[^;]*\bRENAME\s+(?:TO|COLUMN)\b", re.I | re.M | re.S),
)

def scrub_literals_and_comments(sql: str) -> str:
    # Preserve newlines; replace SQL quoted strings and comments so that
    # literal error text and ON DELETE clauses are not treated as DML.
    pattern = re.compile(r"/\*[\s\S]*?\*/|--[^\n]*|'(?:''|[^'])*'|\$([A-Za-z_0-9]*)\$[\s\S]*?\$\1\$")
    def replace(m: re.Match[str]) -> str:
        return "".join("\n" if c == "\n" else " " for c in m.group())
    return pattern.sub(replace, sql)

def audit(root: Path) -> dict:
    items = sorted(root.glob("*/migration.sql"))
    problems = []
    names = [x.parent.name for x in items]
    if len(items) < 2:
        problems.append("EMPTY_OR_INCOMPLETE_MIGRATION_HISTORY")
    if len(names) != len(set(names)):
        problems.append("DUPLICATE_MIGRATION_NAME")
    if not (root / "migration_lock.toml").is_file():
        problems.append("MIGRATION_LOCK_MISSING")
    for path in items:
        raw = path.read_text(encoding="utf-8")
        if not raw.strip():
            problems.append(f"{path.parent.name}:EMPTY_SQL")
            continue
        clean = scrub_literals_and_comments(raw)
        for regex in DANGEROUS:
            if regex.search(clean):
                problems.append(f"{path.parent.name}:MANUAL_REVIEW_{regex.pattern[:32]}")
    return {
        "migration_count": len(items),
        "first_migration": names[0] if names else None,
        "last_migration": names[-1] if names else None,
        "hazard_count": len(problems),
        "hazards": problems,
        "database_inspected": False,
        "sql_applied": False,
    }

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    result = audit(MIGRATIONS)
    if args.json:
        print(json.dumps(result, sort_keys=True))
    else:
        print("PRISMA_MIGRATIONS_COUNT=" + str(result["migration_count"]))
        print("PRISMA_STATIC_HAZARDS=" + str(result["hazard_count"]))
        for item in result["hazards"]:
            print("MANUAL_REVIEW_REQUIRED=" + item)
        print("PRISMA_DB_READ=NO_SQL_EXECUTED=NO")
    return 1 if args.check and result["hazards"] else 0

if __name__ == "__main__":
    raise SystemExit(main())
