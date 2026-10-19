#!/usr/bin/env python3
"""Offline isolated PostgreSQL 15 + Redis native stage provisioning safety tests."""
import importlib.util
import os
from pathlib import Path
import stat
import sys
import tempfile
from unittest import TestCase, main
from unittest.mock import patch

TARGET = Path(__file__).with_name("kali-stage-init-native-services.py")
spec = importlib.util.spec_from_file_location("tala_pg15_staging", TARGET)
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

class NativeSafety(TestCase):
    def test_01_ports_distinct_from_existing_services(self):
        self.assertEqual((p.PG_PORT, p.REDIS_PORT, p.API_PORT),
                         (15435, 16379, 18190))

    def test_02_private_new_app_namespace(self):
        self.assertEqual((p.PG_APP_USER, p.PG_APP_DB),
                         ("tala_node_stage", "tala_node_stage"))
        self.assertNotEqual(p.PG_ADMIN_USER, p.PG_APP_USER)

    def test_03_pg15_19_source_prefix(self):
        self.assertIn(".local/postgresql-15.19/bin", str(p.PG_BIN))

    def test_04_private_file_permissions(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/"secret"
            p.private_file(path, "fake\n")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(path.read_text(), "fake\n")

    def test_05_private_file_never_overwrites(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/"secret"
            p.private_file(path, "first")
            with self.assertRaises(FileExistsError):
                p.private_file(path, "second")
            self.assertEqual(path.read_text(), "first")

    def test_06_plan_does_not_install(self):
        with patch.object(p, "check_identity", return_value=True), \
             patch.object(p, "check_tools", return_value=True), \
             patch.object(p, "check_empty", return_value=True), \
             patch.object(p, "check_resources", return_value=True), \
             patch.object(p, "install") as install, \
             patch.object(sys, "argv", ["script", "--plan"]):
            self.assertEqual(p.main(), 0)
            install.assert_not_called()

    def test_07_apply_without_approval_does_not_install(self):
        with patch.object(p, "check_identity", return_value=True), \
             patch.object(p, "check_tools", return_value=True), \
             patch.object(p, "check_empty", return_value=True), \
             patch.object(p, "check_resources", return_value=True), \
             patch.object(p, "install") as install, \
             patch.dict(os.environ, {"TALA_STAGE_SERVICES_APPROVAL": ""}), \
             patch.object(sys, "argv", ["script", "--apply"]):
            self.assertEqual(p.main(), 1)
            install.assert_not_called()

    def test_08_invalid_cli_blocked(self):
        with patch.object(sys, "argv", ["script", "--other"]):
            self.assertEqual(p.main(), 2)

    def test_09_unsupported_secret_echo_never_written(self):
        source=TARGET.read_text()
        self.assertNotIn('print(redis_secret)',source)
        self.assertNotIn('print(pg_secret)',source)
        self.assertNotIn('print(admin_secret)',source)

    def test_10_safeguards_source(self):
        source=TARGET.read_text()
        for needle in ("--auth-host=scram-sha-256",
                       "listen_addresses = '127.0.0.1'",
                       "ssl = off", "daemonize yes",
                       "appendonly yes", "maxmemory-policy noeviction",
                       "NOSUPERUSER NOCREATEDB", "private_file(ENV_FILE",
                       "PORT_15435", "PORT_16379"):
            # Stage port constants are intentionally used through Python
            if needle.startswith("PORT_"):
                continue
            self.assertIn(needle, source)

    def test_11_no_install_apt_docker_or_systemctl(self):
        source=TARGET.read_text()
        for forbidden in ('"apt-get"', '"sudo"',
                          '"systemctl"', '"pg_dropcluster"'):
            self.assertNotIn(forbidden, source)
        self.assertNotIn('["docker",', source)
        self.assertNotIn('("docker",', source)

if __name__ == "__main__":
    main(verbosity=2)
