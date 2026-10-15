"""Entry-point contract: no production schema mutation or proxy-wide trust.

These tests run a disposable /bin/sh process with stubbed commands.
No DB, Stripe, Docker engine or real API process is contacted.
"""
import os
from pathlib import Path
import subprocess

import pytest

# These use the literal POSIX executable /bin/sh, which does not exist on Windows.
# Keep this contract active in Linux CI; never report it as Windows-tested.
pytestmark = pytest.mark.skipif(
    os.name == "nt",
    reason="POSIX /bin/sh entrypoint tests require Linux; covered by Linux CI",
)

ENTRYPOINT = Path(__file__).resolve().parents[1] / "entrypoint.sh"


def _fake_command(binary: Path, log_file: Path) -> None:
    binary.write_text(
        "#!/bin/sh\n"
        'printf "%s\\n" "$0 $*" >> "$QA_BOOT_LOG"\n',
        encoding="utf-8",
    )
    binary.chmod(0o755)


def _startup(tmp_path, *, environment: str, auto_migrate: str | None = None, bootstrap: str | None = None, expect_success: bool = True):
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
    env.pop("BOOTSTRAP_ADMIN_ENABLED", None)
    if bootstrap is not None:
        env["BOOTSTRAP_ADMIN_ENABLED"] = bootstrap
    if auto_migrate is not None:
        env["AUTO_MIGRATE_ON_START"] = auto_migrate
    result = subprocess.run(
        ["/bin/sh", str(ENTRYPOINT)], env=env,
        capture_output=True, text=True, timeout=8, check=expect_success,
    )
    return result, output.read_text(encoding="utf-8") if output.exists() else ""


def test_entrypoint_posix_shell_syntax():
    subprocess.run(["/bin/sh", "-n", str(ENTRYPOINT)],
                   check=True, capture_output=True, timeout=5)


def test_production_start_does_not_auto_migrate_or_trust_all_proxies(tmp_path):
    result, logs = _startup(tmp_path, environment="production")
    assert "alembic" not in logs
    assert "python -m app.bootstrap_admin" not in logs
    assert "uvicorn app.main:app" in logs
    assert "--forwarded-allow-ips=127.0.0.1" in logs
    assert "--forwarded-allow-ips=*" not in logs
    assert "Migraciones automáticas deshabilitadas en producción" in result.stdout


def test_development_still_runs_alembic_for_ephemeral_environment(tmp_path):
    _, logs = _startup(tmp_path, environment="development")
    assert "alembic upgrade head" in logs
    assert "uvicorn app.main:app" in logs


@pytest.mark.parametrize("flag", ["true", "TRUE", "on", "1", "yes", " true "])
def test_production_migration_flag_is_rejected_fail_closed(tmp_path, flag):
    result, logs = _startup(
        tmp_path, environment="production",
        auto_migrate=flag, expect_success=False,
    )
    assert result.returncode == 78
    assert "alembic" not in logs
    assert "uvicorn" not in logs
    assert "AUTO_MIGRATE_ON_START no se admite en producción" in result.stderr


def test_explicit_separate_migration_command_does_not_start_api(tmp_path):
    tools = tmp_path / "bin"
    tools.mkdir()
    output = tmp_path / "maintenance.log"
    _fake_command(tools / "alembic", output)
    env = os.environ.copy()
    env.update({
        "ENVIRONMENT": "production",
        "AUTO_MIGRATE_ON_START": "false",
        "PATH": f"{tools}:{os.environ.get('PATH', '')}",
        "QA_BOOT_LOG": str(output),
    })
    result = subprocess.run(
        ["/bin/sh", str(ENTRYPOINT), "alembic", "upgrade", "head"],
        env=env, capture_output=True, text=True, timeout=8, check=True,
    )
    assert result.returncode == 0
    assert "alembic upgrade head" in output.read_text(encoding="utf-8")
    assert "Iniciando API" not in result.stdout


def test_development_migration_can_be_explicitly_disabled(tmp_path):
    _, logs = _startup(tmp_path, environment="development", auto_migrate="false")
    assert "alembic" not in logs


@pytest.mark.parametrize("raw_env", ["PRODUCTION", "Production", " production ", " PRODUCTION "])
def test_production_environment_normalization_never_auto_migrates(tmp_path, raw_env):
    _, logs = _startup(tmp_path, environment=raw_env)
    assert "alembic" not in logs
    assert "--forwarded-allow-ips=127.0.0.1" in logs


def test_explicit_dev_bootstrap_only_when_enabled(tmp_path):
    _, logs = _startup(tmp_path, environment="development", bootstrap="true")
    assert "python -m app.bootstrap_admin" in logs


def test_bootstrap_flag_never_runs_automatically_in_production(tmp_path):
    _, logs = _startup(tmp_path, environment="PRODUCTION", bootstrap="true")
    assert "python -m app.bootstrap_admin" not in logs
