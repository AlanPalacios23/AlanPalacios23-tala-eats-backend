#!/usr/bin/env python3
"""Fail-closed source release hygiene checks. No network or production access.

This script intentionally checks only source files; vulnerability detection in
third-party packages and production runtime security need separate controls.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import re
import subprocess
import sys
import tempfile

PATTERNS = {
    "Stripe LIVE restricted/secret key": re.compile(rb'\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b'),
    "Stripe webhook signing secret": re.compile(rb'\bwhsec_[A-Za-z0-9]{20,}\b'),
    "GitHub access token": re.compile(rb'\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{25,}\b'),
    "AWS access key": re.compile(rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
    "Private key block": re.compile(rb'(?m)^[ \\t]*-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[ \\t]*
}
SOURCE_EXT = {'.py', '.ini', '.toml', '.sh', '.yaml', '.yml', '.txt', '.json', '.cfg', '.conf'}
ALLOWED_EXAMPLE_FILES = {'.env.example', '.env.production.example', '.env.sample'}
RESTRICTED_NAMES = {'id_rsa', 'id_ed25519', 'credentials.json', '.env', '.env.production', '.env.local'}
RESTRICTED_SUFFIXES = {'.pem', '.p12', '.pfx', '.jks', '.key', '.dump', '.sqlite', '.sqlite3', '.db'}
RESTRICTED_SEGMENTS = {'secrets', 'backups', 'private_keys', '__pycache__', 'media'}


def find_paths(root: Path) -> list[Path]:
    result = subprocess.run(['git', '-C', str(root), 'ls-files', '-z'], capture_output=True, check=False)
    if result.returncode == 0:
        return [root / p.decode('utf-8') for p in result.stdout.split(b'\0') if p]
    return [p for p in root.rglob('*') if p.is_file() and '.git' not in p.parts]


def inspect(root: Path, paths: list[Path]) -> list[str]:
    errors = []
    seen = 0
    for p in paths:
        rel = p.relative_to(root)
        parts = rel.parts
        # The sanitized historical snapshot is an explicitly labeled artifact,
        # not a source file. Git history and compiled dependencies are separate.
        if parts[0] == 'snapshots':
            continue
        if not p.is_file():
            errors.append(f'{rel}: tracked file missing')
            continue
        name = p.name.lower()
        if (name in RESTRICTED_NAMES or name.startswith('.env.') and name not in ALLOWED_EXAMPLE_FILES
                or p.suffix.lower() in RESTRICTED_SUFFIXES or any(s.lower() in RESTRICTED_SEGMENTS for s in parts[:-1])):
            errors.append(f'{rel}: disallowed secret/data file path')
            continue
        if p.suffix.lower() not in SOURCE_EXT and not name.startswith('.env.'):
            continue
        if p.stat().st_size > 3_000_000:
            errors.append(f'{rel}: source file too large for reliable secret scan')
            continue
        seen += 1
        data = p.read_bytes()
        for label, pattern in PATTERNS.items():
            if pattern.search(data):
                errors.append(f'{rel}: possible {label} detected; remove and rotate before publishing')
    print(f'SOURCE_PREFLIGHT files_scanned={seen} errors={len(errors)}')
    return errors


def self_test() -> None:
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        ok = root / 'backend' / 'app' / 'safe.py'
        ok.parent.mkdir(parents=True)
        ok.write_text("test_key = 'sk_test_dummy'\n")
        assert inspect(root, [ok]) == []
        # Mentioning a PEM marker in source-code validation is not a leaked key.
        inline_doc = root / 'backend' / 'app' / 'marker_example.py'
        inline_doc.write_text('key.startswith("-----BEGIN OPENSSH PRIVATE KEY-----")\n')
        assert inspect(root, [inline_doc]) == []
        # A real PEM header occupying its own line is still rejected.
        pem_leak = root / 'backend' / 'app' / 'bad_pem.py'
        pem_leak.write_text('"""\n-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----\n"""\n')
        assert inspect(root, [pem_leak])

        leaked = root / 'backend' / 'app' / 'leaked.py'
        leaked.write_text("test_key = 'sk_live_" + "A" * 25 + "'\n")
        assert inspect(root, [leaked])
        private_file = root / 'backend' / '.env.production'
        private_file.write_text('SECRET=x')
        assert inspect(root, [private_file])
    print('SELF_TEST_PASS')


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    root = args.root.resolve()
    if not (root / 'backend' / 'requirements.txt').is_file():
        print('ERROR: expected backend/requirements.txt; wrong repository root', file=sys.stderr)
        return 2
    problems = inspect(root, find_paths(root))
    for finding in problems:
        print('::error::' + finding, file=sys.stderr)
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())),
}
SOURCE_EXT = {'.py', '.ini', '.toml', '.sh', '.yaml', '.yml', '.txt', '.json', '.cfg', '.conf'}
ALLOWED_EXAMPLE_FILES = {'.env.example', '.env.production.example', '.env.sample'}
RESTRICTED_NAMES = {'id_rsa', 'id_ed25519', 'credentials.json', '.env', '.env.production', '.env.local'}
RESTRICTED_SUFFIXES = {'.pem', '.p12', '.pfx', '.jks', '.key', '.dump', '.sqlite', '.sqlite3', '.db'}
RESTRICTED_SEGMENTS = {'secrets', 'backups', 'private_keys', '__pycache__', 'media'}


def find_paths(root: Path) -> list[Path]:
    result = subprocess.run(['git', '-C', str(root), 'ls-files', '-z'], capture_output=True, check=False)
    if result.returncode == 0:
        return [root / p.decode('utf-8') for p in result.stdout.split(b'\0') if p]
    return [p for p in root.rglob('*') if p.is_file() and '.git' not in p.parts]


def inspect(root: Path, paths: list[Path]) -> list[str]:
    errors = []
    seen = 0
    for p in paths:
        rel = p.relative_to(root)
        parts = rel.parts
        # The sanitized historical snapshot is an explicitly labeled artifact,
        # not a source file. Git history and compiled dependencies are separate.
        if parts[0] == 'snapshots':
            continue
        if not p.is_file():
            errors.append(f'{rel}: tracked file missing')
            continue
        name = p.name.lower()
        if (name in RESTRICTED_NAMES or name.startswith('.env.') and name not in ALLOWED_EXAMPLE_FILES
                or p.suffix.lower() in RESTRICTED_SUFFIXES or any(s.lower() in RESTRICTED_SEGMENTS for s in parts[:-1])):
            errors.append(f'{rel}: disallowed secret/data file path')
            continue
        if p.suffix.lower() not in SOURCE_EXT and not name.startswith('.env.'):
            continue
        if p.stat().st_size > 3_000_000:
            errors.append(f'{rel}: source file too large for reliable secret scan')
            continue
        seen += 1
        data = p.read_bytes()
        for label, pattern in PATTERNS.items():
            if pattern.search(data):
                errors.append(f'{rel}: possible {label} detected; remove and rotate before publishing')
    print(f'SOURCE_PREFLIGHT files_scanned={seen} errors={len(errors)}')
    return errors


def self_test() -> None:
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        ok = root / 'backend' / 'app' / 'safe.py'
        ok.parent.mkdir(parents=True)
        ok.write_text("test_key = 'sk_test_dummy'\n")
        assert inspect(root, [ok]) == []
        leaked = root / 'backend' / 'app' / 'leaked.py'
        leaked.write_text("test_key = 'sk_live_" + "A" * 25 + "'\n")
        assert inspect(root, [leaked])
        private_file = root / 'backend' / '.env.production'
        private_file.write_text('SECRET=x')
        assert inspect(root, [private_file])
    print('SELF_TEST_PASS')


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    root = args.root.resolve()
    if not (root / 'backend' / 'requirements.txt').is_file():
        print('ERROR: expected backend/requirements.txt; wrong repository root', file=sys.stderr)
        return 2
    problems = inspect(root, find_paths(root))
    for finding in problems:
        print('::error::' + finding, file=sys.stderr)
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())