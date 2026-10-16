"""F2.03/F2.17 production entrypoint migration guard, isolated shell process QA.

Mocked commands are executable files in a disposable temporary PATH.
No Docker, PostgreSQL, Kali, credentials, network or real Alembic are used.
"""
from pathlib import Path
import os
import subprocess

import pytest

ENTRYPOINT = Path(__file__).resolve().parents[1] / "entrypoint.sh"


def _shell_boot(tmp_path, *, environment, auto_migrate, explicit_command=()):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    marker = tmp_path / "qa-called.log"
    for exe in ("alembic", "uvicorn", "python"):
        binary = bin_dir / exe
        binary.write_text(
            "#!/bin/sh\n"
            "printf '%s\\n' '" + exe + "' >> \"$F203_QA_LOG\"\n",
            encoding="utf-8",
        )
        binary.chmod(0o755)
    env = dict(os.environ)
    env.update({
        "PATH": str(bin_dir) + os.pathsep + env.get("PATH", "/usr/bin:/bin"),
        "F203_QA_LOG": str(marker),
        "ENVIRONMENT": environment,
        "AUTO_MIGRATE_ON_START": auto_migrate,
        "BOOTSTRAP_ADMIN_ENABLED": "false",
        "UVICORN_FORWARDED_ALLOW_IPS": "127.0.0.1",
        "WEB_CONCURRENCY": "2",
    })
    proc = subprocess.run(
        ["/bin/sh", str(ENTRYPOINT), *explicit_command],
        env=env, capture_output=True, text=True, timeout=12, check=False,
    )
    calls = marker.read_text().splitlines() if marker.exists() else []
    return proc, calls


@pytest.mark.parametrize("env_name", ["production", "PRODUCTION", " Production "])
@pytest.mark.parametrize("auto_migrate", ["false", "False", "no", "0"])
def test_production_start_never_invokes_alembic(tmp_path, env_name, auto_migrate):
    proc, calls = _shell_boot(tmp_path, environment=env_name, auto_migrate=auto_migrate)
    assert proc.returncode == 0, proc.stdout
    assert calls == ["uvicorn"]
    assert "Migraciones automáticas deshabilitadas" in proc.stdout


@pytest.mark.parametrize("auto_migrate", ["true", "TRUE", " yes ", "1", "ON"])
def test_production_rejects_legacy_automigrate_flag_closed(tmp_path, auto_migrate):
    proc, calls = _shell_boot(tmp_path, environment=" PrODuCTion ", auto_migrate=auto_migrate)
    assert proc.returncode == 78
    assert calls == []
    assert "AUTO_MIGRATE_ON_START" in proc.stderr


def test_development_migration_remains_an_explicitly_separate_environment(tmp_path):
    proc, calls = _shell_boot(tmp_path, environment="development", auto_migrate="true")
    assert proc.returncode == 0
    assert calls == ["alembic", "uvicorn"]


def test_explicit_approved_maintenance_command_bypasses_api_startup(tmp_path):
    proc, calls = _shell_boot(tmp_path, environment="production",
                              auto_migrate="true", explicit_command=("alembic",))
    assert proc.returncode == 0
    assert calls == ["alembic"]
    assert "Iniciando API" not in proc.stdout
