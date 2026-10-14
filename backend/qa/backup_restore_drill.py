"""Verified BACKUP→RESTORE DRILL against ephemeral PostgreSQL and synthetic media.

Fails closed outside the GitHub QA-only Postgres DSN. Docker postgres:16-alpine
client avoids dependency on the runner's installed pg_dump/pg_restore version.
Never exports customer records from Kali or uploads DB dumps as artifacts.
"""
import hashlib
import os
import subprocess
import tarfile
import tempfile
from pathlib import Path

import psycopg
from psycopg import sql

SOURCE = "postgresql+psycopg://talaqa:qa-only-local@127.0.0.1:5432/talaqa"
RESTORED = "talaqa_restored"

def guard():
    assert os.getenv("DATABASE_URL") == SOURCE, "Only disposable QA DSN is allowed"
    assert os.getenv("ENVIRONMENT") == "development"
    assert os.getenv("STRIPE_ENABLED") == "false"
    assert os.getenv("WITHDRAWALS_EXECUTION_ENABLED") == "false"
    assert not os.getenv("STRIPE_SECRET_KEY")
    assert not os.getenv("MERCADOPAGO_ACCESS_TOKEN")

def pgconn(database):
    return psycopg.connect(host="127.0.0.1", port=5432, dbname=database,
                           user="talaqa", password="qa-only-local")

def docker_pg(*args, stdin=None, stdout=None):
    cmd = ["docker", "run", "--rm", "--network", "host", "-i",
           "-e", "PGPASSWORD=qa-only-local", "postgres:16-alpine", *args]
    subprocess.run(cmd, stdin=stdin, stdout=stdout, check=True, timeout=100)

def fingerprint(database):
    with pgconn(database) as conn:
        tables = [r[0] for r in conn.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")]
        values = {}
        for table in tables:
            q = sql.SQL(
                "SELECT count(*), md5(coalesce(string_agg(md5(row_to_json(t)::text), "
                "'' ORDER BY md5(row_to_json(t)::text)),'')) FROM {} AS t"
            ).format(sql.Identifier(table))
            values[table] = conn.execute(q).fetchone()
        version = conn.execute("SELECT version_num FROM alembic_version").fetchone()[0]
        triggers = conn.execute(
            "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname").fetchall()
    return (values, version, triggers)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def main():
    guard()
    original = fingerprint("talaqa")
    assert original[0]["orders"][0] >= 1, "No synthetic QA orders were generated"
    assert original[0]["financial_ledger_entries"][0] >= 1, "No synthetic QA ledger"
    with tempfile.TemporaryDirectory(prefix="tala-qa-recovery-") as temp:
        workspace = Path(temp)
        dump = workspace / "postgres.dump"
        with dump.open("wb") as out:
            docker_pg("pg_dump", "-h", "127.0.0.1", "-U", "talaqa",
                      "-d", "talaqa", "-Fc", "--no-owner", "--no-acl", stdout=out)
        assert dump.stat().st_size > 1000
        with pgconn("postgres") as conn:
            conn.autocommit = True
            assert not conn.execute("SELECT 1 FROM pg_database WHERE datname = %s",
                                    (RESTORED,)).fetchone(), "Restore DB already exists"
            conn.execute(sql.SQL("CREATE DATABASE {} OWNER talaqa").format(sql.Identifier(RESTORED)))

        with dump.open("rb") as src:
            docker_pg("pg_restore", "-h", "127.0.0.1", "-U", "talaqa",
                      "-d", RESTORED, "--exit-on-error", "--no-owner",
                      "--no-acl", stdin=src)
        restored = fingerprint(RESTORED)
        assert restored == original, "Restored schema/data/triggers differ from source"
        # Simulate media volume recovery using synthetic bytes only.
        media = workspace / "media"
        media.mkdir()
        samples = {
            "qa-product-1.png": b"QA_ONLY_SYNTHETIC_IMAGE_DATA_01",
            "qa-product-2.png": b"QA_ONLY_SYNTHETIC_IMAGE_DATA_02",
        }
        for name, contents in samples.items():
            (media / name).write_bytes(contents)
        archive = workspace / "media.tgz"
        with tarfile.open(archive, "w:gz") as tf:
            for name in samples:
                tf.add(media / name, arcname=name)
        restored_media = workspace / "restored_media"
        restored_media.mkdir()
        with tarfile.open(archive, "r:gz") as tf:
            for item in tf.getmembers():
                assert item.name in samples and item.isfile(), "Unexpected media archive entry"
                (restored_media / item.name).write_bytes(tf.extractfile(item).read())
        assert {n: sha((restored_media / n).read_bytes()) for n in samples} == {
            n: sha(content) for n, content in samples.items()
        }
        assert archive.stat().st_size > 0
        print("EPHEMERAL_BACKUP_RESTORE_PASS", "tables", len(original[0]),
              "rows", sum(v[0] for v in original[0].values()),
              "media_files", len(samples), "alembic", original[1])
        # No backup file or media data is uploaded as an artifact.

if __name__ == "__main__":
    main()
