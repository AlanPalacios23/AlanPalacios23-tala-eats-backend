#!/usr/bin/env python3
"""Offline fail-closed tests for stage backup and systemd-only coldstart."""
import importlib.util
from pathlib import Path
import os
import sys
import tempfile
from unittest import TestCase, main
from unittest.mock import patch

BASE = Path(__file__).resolve().parent

def load(filename, name):
    s = importlib.util.spec_from_file_location(name, BASE / filename)
    v = importlib.util.module_from_spec(s)
    s.loader.exec_module(v)
    return v

backup = load("kali-stage-backup.py", "backup")
switch = load("kali-stage-systemd-cutover.py", "cutover")


class ColdStartSafety(TestCase):
    def test_01_backup_rejects_live_or_wrong_target(self):
        good = {
            "NODE_ENV": "staging",
            "STRIPE_FINANCIAL_WRITES_ENABLED": "false",
            "DATABASE_URL": "postgresql://tala_node_stage:test@127.0.0.1:15435/tala_node_stage",
        }
        self.assertIsNotNone(backup.expected_target(good))
        for bad_url in (
            "postgresql://tala_node_stage:test@127.0.0.1:5432/tala_node_stage",
            "postgresql://tala_node_stage:test@127.0.0.1:15435/production",
            "postgresql://other:test@127.0.0.1:15435/tala_node_stage",
            "postgresql://tala_node_stage:test@192.168.0.2:15435/tala_node_stage",
        ):
            self.assertIsNone(backup.expected_target({**good, "DATABASE_URL": bad_url}))
        self.assertIsNone(backup.expected_target({**good,
                               "STRIPE_FINANCIAL_WRITES_ENABLED": "true"}))

    def test_02_stage_ports_and_unit_names(self):
        self.assertEqual(len(switch.UNITS), 3)
        self.assertTrue(all(x.startswith("tala-node-stage-") for x in switch.UNITS))
        self.assertEqual(switch.APPS, {
            "tala-node-stage-api", "tala-node-stage-worker",
        })

    def test_03_plan_never_stops(self):
        with patch.object(switch, "basic_guards", return_value=True), \
             patch.object(switch, "good") as run, \
             patch.object(switch, "emergency_restore") as restore, \
             patch.object(sys, "argv", ["cmd", "--plan"]):
            self.assertEqual(switch.main(), 0)
            run.assert_not_called()
            restore.assert_not_called()

    def test_04_unapproved_apply_never_stops(self):
        with patch.object(switch, "basic_guards", return_value=True), \
             patch.object(switch, "good") as run, \
             patch.dict(os.environ, {"TALA_STAGE_CUTOVER_APPROVAL": ""}), \
             patch.object(sys, "argv", ["cmd", "--apply"]):
            self.assertEqual(switch.main(), 1)
            run.assert_not_called()

    def test_05_stage_backup_plan_no_pgdump(self):
        with patch.object(backup, "env_values", return_value={"stub": "value"}), \
             patch.object(backup, "expected_target", return_value=("stage", "redacted")), \
             patch.object(backup, "run") as runner, \
             patch.object(sys, "argv", ["cmd", "--plan"]):
            # Test never bypasses account validation, so no live IO/mutation.
            with patch.object(backup, "pwd") as pwdmock:
                pwdmock.getpwuid.return_value.pw_name = "other"
                self.assertEqual(backup.main(), 1)
            runner.assert_not_called()

    def test_06_backup_approval_is_explicit(self):
        self.assertEqual(backup.APPROVAL, "I_APPROVE_STAGE_DB_BACKUP_ONLY")
        self.assertEqual(switch.APPROVAL, "I_APPROVE_STAGE_ONLY_SYSTEMD_CUTOVER")

    def test_07_backup_not_production(self):
        self.assertEqual(backup.HOME, Path("/home/tala-node-stage"))
        self.assertEqual(backup.ENV, Path("/home/tala-node-stage/.config/talaeats-node-staging.env"))
        self.assertEqual(backup.BIN, Path("/home/tala-node-stage/.local/postgresql-15.19/bin"))
        self.assertNotIn("pg18", str(backup.BIN))

    def test_08_no_docker_root_service_or_live_stripe_executions(self):
        code = (BASE / "kali-stage-systemd-cutover.py").read_text()
        self.assertNotIn('["docker"', code)
        self.assertNotIn('["sudo"', code)
        self.assertNotIn('"reboot"', code)
        self.assertNotIn('["systemctl", "restart"', code)
        self.assertNotIn("sk_live_", code)

    def test_09_stage_redis_secret_only_in_env(self):
        code = (BASE / "kali-stage-systemd-cutover.py").read_text()
        self.assertIn('renv["REDISCLI_AUTH"] = rsecret', code)
        self.assertIn('"shutdown", "save"', code)
        self.assertNotIn("print(rsecret)", code)

    def test_10_emergency_restore_stage_only(self):
        code = (BASE / "kali-stage-systemd-cutover.py").read_text()
        self.assertIn('"resurrect"', code)
        self.assertIn('"redis-server", str(rediscfg)', code)
        self.assertIn('"stop", n', code)
        self.assertIn("STAGE_MANUAL_ROLLBACK=PASS", code)

    def test_11_cutover_stops_only_staging_when_all_gates_pass(self):
        calls = []
        def stub_good(args, **kwargs):
            calls.append(args)
            return True
        with patch.object(switch, "basic_guards", return_value=True), \
             patch.object(switch, "good", side_effect=stub_good), \
             patch.object(switch, "redis_auth", return_value="redacted"), \
             patch.object(switch, "ports_closed", return_value=True), \
             patch.object(switch, "unit_state", return_value="active"), \
             patch.object(switch, "pm2_stage_only", return_value=True), \
             patch.object(switch, "ready", return_value=True), \
             patch.dict(os.environ, {
                 "TALA_STAGE_CUTOVER_APPROVAL": switch.APPROVAL}), \
             patch.object(sys, "argv", ["cmd", "--apply"]):
            self.assertEqual(switch.main(), 0)
        self.assertEqual(len(calls), 4)
        self.assertEqual(calls[-1], ["systemctl", "--user", "start", switch.UNITS[-1]])
        self.assertTrue(all("docker" not in " ".join(x).lower() for x in calls))

    def test_12_never_uses_prod_backup(self):
        self.assertIn("/talaeats-node-native/backups", str(backup.BACKUP_DIR))
        self.assertTrue(str(backup.BACKUP_DIR).startswith("/home/tala-node-stage/"))


if __name__ == "__main__":
    main(verbosity=2)
