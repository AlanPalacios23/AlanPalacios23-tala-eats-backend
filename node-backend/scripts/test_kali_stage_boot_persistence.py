#!/usr/bin/env python3
"""Offline only tests: user systemd stages cannot affect live Docker or PG18."""
from __future__ import annotations
import importlib.util
from pathlib import Path
import sys
from unittest import TestCase, main
from unittest.mock import patch

BASE = Path(__file__).resolve().parent
ROOT = BASE.parent
spec = importlib.util.spec_from_file_location(
    "kali_stage_boot_persistence", BASE / "kali-stage-boot-persistence.py")
target = importlib.util.module_from_spec(spec)
spec.loader.exec_module(target)


class UserBootSafety(TestCase):
    def test_stage_units_are_exactly_three(self):
        self.assertEqual(len(target.UNITS), 3)
        self.assertEqual(len(set(target.UNITS)), 3)
        self.assertEqual(set(target.UNITS), {
            "tala-node-stage-pg15.service",
            "tala-node-stage-redis.service",
            "tala-node-stage-pm2.service",
        })

    def test_unit_targets_are_user_manager_only(self):
        for name in target.UNITS:
            u = (ROOT / "ops/systemd" / name).read_text()
            self.assertIn("WantedBy=default.target", u)
            self.assertNotIn("multi-user.target", u)
            self.assertNotIn("User=root", u)
            self.assertNotIn("User=", u)
            self.assertNotIn("Group=", u)
            self.assertNotIn("/usr/lib/postgresql/18", u)
            self.assertNotIn("docker", u.lower())
            self.assertNotIn("stripe", u.lower())

    def test_postgres_unit_only_source_stage_data(self):
        u = (ROOT / "ops/systemd/tala-node-stage-pg15.service").read_text()
        self.assertIn("/home/tala-node-stage/.local/postgresql-15.19/bin/postgres", u)
        self.assertIn("postgres15-data", u)
        self.assertIn("WantedBy=default.target", u)
        self.assertIn("Type=exec", u)

    def test_redis_stage_conf_used_and_foreground(self):
        u = (ROOT / "ops/systemd/tala-node-stage-redis.service").read_text()
        self.assertIn("redis-stage.conf --daemonize no", u)
        self.assertIn("Type=exec", u)

    def test_pm2_user_requirements_and_ready_gates(self):
        u = (ROOT / "ops/systemd/tala-node-stage-pm2.service").read_text()
        self.assertIn("Requires=tala-node-stage-pg15.service tala-node-stage-redis.service", u)
        self.assertIn("--dependencies", u)
        self.assertIn("--health", u)
        self.assertIn("pm2 resurrect", u)
        self.assertIn(".pm2/dump.pm2", u)
        self.assertIn("PIDFile=/home/tala-node-stage/.pm2/pm2.pid", u)

    def test_plan_only_never_runs_apply(self):
        with patch.object(target, "check_user", return_value=True), \
             patch.object(target, "units_safe", return_value=True), \
             patch.object(target, "stage_readiness", return_value=True), \
             patch.object(target, "linger_ok", return_value=False), \
             patch.object(target, "NODE") as node, \
             patch.object(target, "PM2_JS") as pm2, \
             patch.object(target, "run") as runner, \
             patch.object(sys, "argv", ["script", "--plan"]):
            node.is_file.return_value = True
            pm2.is_file.return_value = True
            self.assertEqual(target.main(), 0)
            runner.assert_not_called()

    def test_apply_without_approval_never_saves_pm2(self):
        with patch.object(target, "check_user", return_value=True), \
             patch.object(target, "units_safe", return_value=True), \
             patch.object(target, "stage_readiness", return_value=True), \
             patch.object(target, "linger_ok", return_value=True), \
             patch.object(target, "NODE") as node, \
             patch.object(target, "PM2_JS") as pm2, \
             patch.object(target, "run") as runner, \
             patch.dict("os.environ", {"TALA_STAGE_BOOT_APPROVAL": ""}), \
             patch.object(sys, "argv", ["script", "--apply"]):
            node.is_file.return_value = True
            pm2.is_file.return_value = True
            self.assertEqual(target.main(), 1)
            runner.assert_not_called()

    def test_startup_checker_no_credential_output(self):
        c = (BASE / "kali-stage-startup-check.py").read_text()
        self.assertIn("127.0.0.1:18190/api/v1/ready", c)
        self.assertIn('body.get("financialWrites") is False', c)
        self.assertIn("tala-node-stage-worker", c)
        self.assertNotIn("stripe.payouts", c)
        self.assertNotIn("docker compose", c)

    def test_source_install_script_cannot_start_current_services(self):
        c = (BASE / "kali-stage-boot-persistence.py").read_text()
        self.assertIn('"enable", *UNITS', c)
        self.assertNotIn('"enable", "--now"', c)
        self.assertNotIn('"restart", *UNITS', c)
        self.assertNotIn('"start", *UNITS', c)
        self.assertNotIn('"reboot"', c)

    def test_hard_target_only_user_account(self):
        self.assertEqual(target.USER, "tala-node-stage")
        self.assertEqual(target.HOME, Path("/home/tala-node-stage"))
        self.assertEqual(target.DEST, Path("/home/tala-node-stage/.config/systemd/user"))

if __name__ == "__main__":
    main(verbosity=2)
