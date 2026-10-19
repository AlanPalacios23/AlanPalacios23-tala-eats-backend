#!/usr/bin/env python3
"""Offline checks: isolated PG15 staging restore never mutates live clusters."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from unittest import TestCase, main
from unittest.mock import patch

SRC = Path(__file__).with_name("kali-stage-test-restore.py")
spec = importlib.util.spec_from_file_location("stage_restore", SRC)
target = importlib.util.module_from_spec(spec)
spec.loader.exec_module(target)

class RestoreSafety(TestCase):
    def test_01_paths_only_staging_home(self):
        self.assertEqual(target.PORT, "15436")
        self.assertIn("/home/tala-node-stage", str(target.BIN))
        self.assertIn("talaeats-node-native/backups", str(target.BACKUPS))

    def test_02_plan_does_not_create_or_start_any_services(self):
        with patch.object(target, "stage_user", return_value=True), \
             patch.object(target, "pg15_bins", return_value=True), \
             patch.object(target, "source_unchanged", return_value=True), \
             patch.object(target, "backups_safe", return_value=[Path("/tmp/fake.dump")]), \
             patch.object(target.ROOT, "is_dir", return_value=True), \
             patch.object(target.ROOT, "is_symlink", return_value=False), \
             patch.object(target, "exec_cmd", return_value=(True, "valid")), \
             patch.object(target.tempfile, "mkdtemp") as m, \
             patch.object(sys, "argv", ["script", "--plan"]):
            self.assertEqual(target.main(), 0)
            m.assert_not_called()

    def test_03_no_approval_refuses_create(self):
        with patch.object(target, "stage_user", return_value=True), \
             patch.object(target, "pg15_bins", return_value=True), \
             patch.object(target, "source_unchanged", return_value=True), \
             patch.object(target, "backups_safe", return_value=[Path("/tmp/fake.dump")]), \
             patch.object(target.ROOT, "is_dir", return_value=True), \
             patch.object(target.ROOT, "is_symlink", return_value=False), \
             patch.object(target, "exec_cmd", return_value=(True, "valid")), \
             patch.object(target.tempfile, "mkdtemp") as m, \
             patch.dict(os.environ, {"TALA_STAGE_RESTORE_APPROVAL": ""}), \
             patch.object(sys, "argv", ["script", "--apply"]):
            self.assertEqual(target.main(), 1)
            m.assert_not_called()

    def test_04_only_unix_socket_and_no_tcp_listener(self):
        src=SRC.read_text()
        self.assertIn("listen_addresses = ''", src)
        self.assertIn("--auth-host=reject", src)
        self.assertIn("unix_socket_permissions = 0700", src)
        self.assertNotIn('["docker"', src)
        self.assertNotIn('["sudo"', src)
        self.assertNotIn('["pg_ctlcluster"', src)

    def test_05_requires_schema_migration_recovered(self):
        src=SRC.read_text()
        self.assertIn("20261019_initial", src)
        self.assertIn("merchant_connect_accounts", src)
        self.assertIn("payout_instructions", src)
        self.assertIn("--single-transaction", src)
        self.assertIn("--no-owner", src)
        self.assertIn("--no-acl", src)

    def test_06_no_backups_exposed_in_output(self):
        src=SRC.read_text()
        self.assertNotIn("print(str(src))", src)
        self.assertNotIn("print(source_url)", src)
        self.assertIn("ABORT_PRIVATE_STAGING_BACKUP_MISSING", src)

    def test_07_no_reboot_or_live_financial_writes(self):
        src=SRC.read_text()
        self.assertNotIn('"reboot"', src)
        self.assertNotIn("sk_live_", src)
        self.assertIn("NO_LIVE_PRODUCTION_PG18_DOCKER_STRIPE_OPERATIONS=yes", src)

if __name__ == "__main__":
    main(verbosity=2)
