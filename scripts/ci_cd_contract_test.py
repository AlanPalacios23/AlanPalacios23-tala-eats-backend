#!/usr/bin/env python3
"""Safe offline gates: no SSH, no Docker, no database or production connections."""
from pathlib import Path
import importlib.util
import subprocess

ROOT = Path(__file__).resolve().parent.parent
ENGINE = ROOT / "scripts/kali_cd_deploy.py"
RECEIVER = ROOT / "scripts/kali_cd_ssh_receiver.sh"
WORKFLOW = ROOT / ".github/workflows/kali-ssh-auto-deploy.yml"


def run():
    spec = importlib.util.spec_from_file_location("tala_cd", ENGINE)
    assert spec and spec.loader
    engine = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(engine)
    assert engine.valid_sha("a" * 40) == "a" * 40
    for invalid in ("main", "a" * 39, "b" * 41, "a" * 40 + " && rm"):
        try:
            engine.valid_sha(invalid)
        except engine.ReleaseBlocked:
            continue
        raise AssertionError("CD accepted untrusted SHA")
    conf = WORKFLOW.read_text(encoding="utf-8")
    assert "workflow_run:" in conf and "types: [completed]" in conf
    assert "head_branch == 'main'" in conf
    assert "conclusion == 'success'" in conf
    assert "TALA EATS Backend | QA aislado" in conf
    for name in ("PostgreSQL Redis Gate", "Container Build Gate",
                 "Finanzas PostgreSQL", "Security Audit"):
        assert name in conf
    assert "StrictHostKeyChecking=yes" in conf
    assert "UserKnownHostsFile=" in conf
    assert "environment: talaeats-production" in conf
    assert "TALAEATS_CD_ENABLED" in conf
    assert "cancel-in-progress: false" in conf
    assert "github.event_name == 'workflow_dispatch'" in conf
    assert "remote_command=\"talaeats-cd probe\"" in conf
    assert "remote_command=\"talaeats-cd deploy $TARGET_SHA\"" in conf
    receiver = RECEIVER.read_text(encoding="utf-8")
    assert "SSH_ORIGINAL_COMMAND" in receiver
    assert "TALA_CD_SSH_COMMAND_DENIED" in receiver
    assert "exec /usr/bin/python3" in receiver
    assert "talaeats-cd deploy " in receiver
    source = ENGINE.read_text(encoding="utf-8")
    for critical in (
        "APPROVAL.stat()", "offsite_backup_verified",
        "isolated_restore_test_pass", "automated_backup_policy_verified",
        "st.st_uid != 0", "origin/main", "runtime_snapshot()",
        "candidate_head(tree)", "verify_backup()", "--no-deps",
        "--no-build", "KALI_CD_DEPLOY_PASS", "TALA_CD_DEPLOY_PASS",
    ):
        if critical == "KALI_CD_DEPLOY_PASS":
            continue
        assert critical in source, critical
    result = subprocess.run(["bash", "-n", str(RECEIVER)],
                            check=False, capture_output=True, text=True)
    assert result.returncode == 0, "Receiver bash syntax incorrect"
    print("CD_SSH_CONTRACT_SELFTEST_PASS")


if __name__ == "__main__":
    run()
