"""F2.03: isolated encrypted PostgreSQL/media restore; never touches Kali or LIVE.

Only permitted on the exact disposable GitHub Actions PG16/Redis8 QA fixture.
Passing does NOT certify an offsite production backup or restoration.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import tarfile
import tempfile
from uuid import uuid4

import psycopg
from psycopg import sql
from sqlalchemy import create_engine, text
from app.config import settings

SOURCE = "postgresql+psycopg://talaqa:qa-only-local@127.0.0.1:5432/talaqa"
REDIS = "redis://127.0.0.1:6379/0"
PREFIX = "talaqa_f203_restore_"
ADMIN = "postgresql://talaqa:qa-only-local@127.0.0.1:5432/postgres"
MEDIA_PATH = "synthetic-media/qa-photo.bin"
MEDIA = b"TALA_EATS_F203_SYNTHETIC_MEDIA_ONLY\n"


def safe_db(name: str) -> str:
    if not re.fullmatch(r"talaqa_f203_restore_[0-9a-f]{24}", name):
        raise ValueError("F203: refuse any non-random CI restore DB")
    return name


def require_ci():
    if not (os.getenv("GITHUB_ACTIONS") == "true"
            and os.getenv("DATABASE_URL") == SOURCE == settings.database_url
            and os.getenv("REDIS_URL") == REDIS == settings.redis_url
            and settings.environment == "development"
            and not settings.seed_demo_data
            and not settings.stripe_enabled
            and not settings.stripe_connect_enabled
            and not settings.withdrawals_preview_enabled
            and not settings.withdrawals_execution_enabled
            and not settings.withdrawals_live_enabled
            and not settings.stripe_secret_key
            and not settings.stripe_connect_webhook_secret
            and not settings.mercado_pago_access_token):
        raise RuntimeError("F203: exact disposable/no-LIVE CI fixture required")
    for tool in ("pg_dump", "pg_restore", "gpg"):
        if not shutil.which(tool):
            raise RuntimeError("F203 missing disposable runner tool: " + tool)


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(part)
    return value.hexdigest()


def ledger(url: str) -> tuple[int, str]:
    engine = create_engine(url)
    try:
        with engine.connect() as conn:
            rows = conn.execute(text(
                "SELECT id,idempotency_key,account,direction,amount,currency,kind "
                "FROM financial_ledger_entries ORDER BY id")).all()
            if not rows:
                raise AssertionError("F203 needs synthetic F2.11 ledger")
            canonical = repr(tuple(tuple(map(str, row)) for row in rows)).encode()
            return len(rows), hashlib.sha256(canonical).hexdigest()
    finally:
        engine.dispose()


def run(argv, *, phrase=None, env=None):
    # No stdout/stderr/credentials from a failed subprocess enter CI logs.
    result = subprocess.run(argv, input=(phrase + "\n") if phrase else None,
                            text=bool(phrase), env=env, capture_output=True,
                            timeout=160, check=False)
    if result.returncode:
        raise RuntimeError("F203 local command failed: " + argv[0])


def seal(clear: Path, cipher: Path, phrase: str):
    run(["gpg", "--batch", "--yes", "--no-tty", "--pinentry-mode", "loopback",
         "--passphrase-fd", "0", "--cipher-algo", "AES256", "--symmetric",
         "--output", str(cipher), str(clear)], phrase=phrase)
    if not cipher.is_file() or not cipher.stat().st_size:
        raise AssertionError("F203 empty cipher")


def unseal(cipher: Path, clear: Path, phrase: str):
    run(["gpg", "--batch", "--yes", "--no-tty", "--pinentry-mode", "loopback",
         "--passphrase-fd", "0", "--decrypt", "--output", str(clear),
         str(cipher)], phrase=phrase)


def create_media(path: Path):
    with tarfile.open(path, "w") as tar:
        info = tarfile.TarInfo(MEDIA_PATH)
        info.size, info.mode, info.mtime = len(MEDIA), 0o600, 0
        tar.addfile(info, io.BytesIO(MEDIA))


def verify_media(path: Path):
    with tarfile.open(path, "r") as tar:
        items = tar.getmembers()
        if len(items) != 1 or items[0].name != MEDIA_PATH or not items[0].isfile():
            raise AssertionError("F203 unsafe media archive")
        stream = tar.extractfile(items[0])
        if stream is None or stream.read() != MEDIA:
            raise AssertionError("F203 media integrity mismatch")


def verify_cipher(path: Path, checksum: str):
    if digest(path) != checksum:
        raise RuntimeError("F203 corrupt ciphertext rejected")


def self_test():
    for invalid in ("postgres", "talaqa", PREFIX, PREFIX + "a" * 23, PREFIX + "X" * 24):
        try:
            safe_db(invalid)
        except ValueError:
            continue
        raise AssertionError("F203 allowed unsafe database name")
    assert safe_db(PREFIX + "a" * 24)
    with tempfile.TemporaryDirectory(prefix="f203-selftest-") as tmp:
        path = Path(tmp) / "media.tar"
        create_media(path)
        verify_media(path)
        before = digest(path)
        path.write_bytes(path.read_bytes() + b"tamper")
        try:
            verify_cipher(path, before)
        except RuntimeError:
            pass
        else:
            raise AssertionError("F203 tamper guard failed open")
    print("F203_GUARDS_MEDIA_INTEGRITY_SELFTEST_PASS")


def main():
    require_ci()
    name = safe_db(PREFIX + uuid4().hex[:24])
    original = ledger(SOURCE)
    env = {**os.environ, "PGPASSWORD": "qa-only-local"}
    with tempfile.TemporaryDirectory(prefix="tala-f203-") as tmp:
        root = Path(tmp)
        pg, media = root / "pg.dump", root / "media.tar"
        pg_gpg, media_gpg = root / "pg.dump.gpg", root / "media.tar.gpg"
        phrase = secrets.token_urlsafe(48)
        try:
            run(["pg_dump", "-h", "127.0.0.1", "-p", "5432", "-U", "talaqa",
                 "-d", "talaqa", "-Fc", "--no-owner", "--no-acl",
                 "-f", str(pg)], env=env)
            with pg.open("rb") as f:
                if f.read(5) != b"PGDMP":
                    raise AssertionError("F203 malformed PostgreSQL dump")
            create_media(media)
            hashes = digest(pg), digest(media)
            seal(pg, pg_gpg, phrase)
            seal(media, media_gpg, phrase)
            pg.unlink()
            media.unlink()
            encrypted_hashes = digest(pg_gpg), digest(media_gpg)
            if hashes == encrypted_hashes:
                raise AssertionError("F203 backup unexpectedly plaintext")
            verify_cipher(pg_gpg, encrypted_hashes[0])
            verify_cipher(media_gpg, encrypted_hashes[1])
            unseal(pg_gpg, pg, phrase)
            unseal(media_gpg, media, phrase)
            if (digest(pg), digest(media)) != hashes:
                raise AssertionError("F203 decrypt changed backup")
            verify_media(media)
            created = False
            with psycopg.connect(ADMIN, autocommit=True) as admin:
                try:
                    admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
                    created = True
                    run(["pg_restore", "-h", "127.0.0.1", "-p", "5432",
                         "-U", "talaqa", "-d", name, "--no-owner", "--no-acl",
                         "--exit-on-error", str(pg)], env=env)
                    restored = ledger(
                        "postgresql+psycopg://talaqa:qa-only-local@127.0.0.1:5432/" + name)
                    if restored != original:
                        raise AssertionError("F203 restored financial ledger changed")
                finally:
                    if created:
                        admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                            sql.Identifier(safe_db(name))))
        finally:
            phrase = ""
    print("F203_SYNTHETIC_ENCRYPTED_PG_MEDIA_RESTORE_PASS: ciphertext SHA256, "
          "AES256, ledger unchanged; no Kali, no banking, no LIVE. "
          "Production offsite restore remains PENDING")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    if parser.parse_args().self_test:
        self_test()
    else:
        main()
