"""Entry-point contract: no production schema mutation or proxy-wide trust.

These tests run a disposable /bin/sh process with stubbed commands.
No DB, Stripe, Docker engine or real API process is contacted.
"""
import os
from pathlib import Path
import subprocess

import pytest

ENTRYPOINT = Path(__file__).resolve().parents[1] / "entrypoint.sh"


def _fake_command(binary: Path, log_file: Path) -> None:
    binary.write_text(
        "#!/bin/sh\n"
        'printf "%s\\n" "$0 $*" >> "$QA_BOOT_LOG"\n',
        encoding="utf-8",
    )
    binary.chmod(0o755)


def _startup(tmp_path, *, environment: str, auto_migrate: str | None = None):
    tools = tmp_path / "bin"
    tools.mkdir()
    output = tmp_path / "boot.log"
    for name in ("uvicorn", "alembic", "python"):
        _fake_command(tools / name, output)
    env = os.environ.copy()
    env.update({
        "ENVIRONMENT": environment,
        "PATH": f"{tools}:{os.environ.get('PATH', '')}",
        "QA_BOOT_LOG": str(output),
    })
    env.pop("AUTO_MIGRATE_ON_START", None)
    env.pop("UVICORN_FORWARDED_ALLOW_IPS", None)
    if auto_migrate is not None:
        env["AUTO_MIGRATE_ON_START"] = auto_migrate
    result = subprocess.run(
        ["/bin/sh", str(ENTRYPOINT)], env=env,
        capture_output=True, text=True, timeout=8, check=True,
    )
    return result, output.read_text(encoding="utf-8")


def test_entrypoint_posix_shell_syntax():
    subprocess.run(["/bin/sh", "-n", str(ENTRYPOINT)],
                   check=True, capture_output=True, timeout=5)


def test_production_start_does_not_auto_migrate_or_trust_all_proxies(tmp_path):
    result, logs = _startup(tmp_path, environment="production")
    assert "alembic" not in logs
    assert "python -m app.bootstrap_admin" in logs
    assert "uvicorn app.main:app" in logs
    assert "--forwarded-allow-ips=127.0.0.1" in logs
    assert "--forwarded-allow-ips=*" not in logs
    assert "Migraciones automáticas deshabilitadas en producción" in result.stdout


def test_development_still_runs_alembic_for_ephemeral_environment(tmp_path):
    _, logs = _startup(tmp_path, environment="development")
    assert "alembic upgrade head" in logs
    assert "uvicorn app.main:app" in logs


def test_production_migration_opt_in_must_be_explicit(tmp_path):
    _, logs = _startup(tmp_path, environment="production", auto_migrate="true")
    assert "alembic upgrade head" in logs


def test_development_migration_can_be_explicitly_disabled(tmp_path):
    _, logs = _startup(tmp_path, environment="development", auto_migrate="false")
    assert "alembic" not in logs
