"""F1.02 release migration: POSIX contract, never touches a real DB."""
import hashlib
import os
from pathlib import Path
import subprocess

import pytest

pytestmark = pytest.mark.skipif(
    os.name == "nt", reason="Explicit maintenance script needs Linux /bin/sh",
)
ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "backend" / "scripts" / "approved_migration.sh"


def _sandbox(tmp_path):
    fakebin = tmp_path / "bin"
    fakebin.mkdir()
    proof = tmp_path / "qa-synthetic-backup.dump"
    proof.write_bytes(b"not-a-real-pg-dump-qa-only")
    log = tmp_path / "recorded-migration.log"
    (fakebin / "python").write_text(
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$QA_MIGRATION_COMMAND_LOG\"\n",
        encoding="utf-8",
    )
    (fakebin / "python").chmod(0o755)
    actual_sha = subprocess.check_output(
        ["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True,
    ).strip()
    env = {**os.environ,
        "ENVIRONMENT": "production",
        "DATABASE_URL": "postgresql+psycopg://synthetic-qa@127.0.0.1/not-real",
        "TALA_MIGRATION_APPROVED": "YES-I-APPROVE-PRODUCTION-MIGRATION",
        "TALA_RESTORE_VERIFIED": "YES",
        "TALA_CHANGE_TICKET": "QA-F1-ONLY-NOT-A-REAL-CHANGE",
        "TALA_APPROVED_BACKUP_FILE": str(proof),
        "TALA_BACKUP_SHA256": hashlib.sha256(proof.read_bytes()).hexdigest(),
        "TALA_APPROVED_RELEASE_SHA": actual_sha,
        "QA_MIGRATION_COMMAND_LOG": str(log),
        "PATH": f"{fakebin}:{os.environ.get('PATH', '')}",
    }
    return env, log


def _call(env):
    return subprocess.run(
        ["/bin/sh", str(SCRIPT)], env=env, cwd=ROOT / "backend",
        capture_output=True, text=True, timeout=8,
    )


def test_explicit_approved_migration_runs_exactly_one_command(tmp_path):
    env, log = _sandbox(tmp_path)
    result = _call(env)
    assert result.returncode == 0, (result.stdout, result.stderr)
    assert log.read_text(encoding="utf-8").splitlines() == ["-m alembic upgrade head"]


@pytest.mark.parametrize("bad", [
    {"ENVIRONMENT": "development"},
    {"ENVIRONMENT": " Productionz "},
    {"DATABASE_URL": "sqlite://"},
    {"TALA_MIGRATION_APPROVED": ""},
    {"TALA_RESTORE_VERIFIED": "no"},
    {"TALA_CHANGE_TICKET": ""},
    {"TALA_APPROVED_BACKUP_FILE": "/not-an-actual-file"},
    {"TALA_BACKUP_SHA256": "0" * 64},
    {"TALA_APPROVED_RELEASE_SHA": "0" * 40},
])
def test_migration_fails_closed_before_db_mutation(tmp_path, bad):
    env, log = _sandbox(tmp_path)
    env.update(bad)
    result = _call(env)
    assert result.returncode == 78, (bad, result.stdout, result.stderr)
    assert not log.exists(), "Refused migration invoked the database command!"


def test_migration_shell_syntax():
    subprocess.run(["/bin/sh", "-n", str(SCRIPT)], check=True)
