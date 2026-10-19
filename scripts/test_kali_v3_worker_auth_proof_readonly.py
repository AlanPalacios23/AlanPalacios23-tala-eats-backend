#!/usr/bin/env python3
"""Offline tests: no DB, no Docker, no exposed credentials."""
import importlib.util
import json
from pathlib import Path
import unittest

path=Path(__file__).with_name("kali_v3_worker_auth_proof_readonly.py")
spec=importlib.util.spec_from_file_location("worker_auth",path)
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class SafeTests(unittest.TestCase):
    def test_01_secret_extraction_only_expected(self):
        data=mod.env_subset(["POSTGRES_USER=app","POSTGRES_DB=mydb",
                             "POSTGRES_PASSWORD=NO_LOGGING",
                             "STRIPE_SECRET_KEY=DO_NOT_TOUCH"])
        self.assertEqual(set(data),{"POSTGRES_USER","POSTGRES_DB","POSTGRES_PASSWORD"})
        self.assertNotIn("STRIPE_SECRET_KEY",data)
    def test_02_no_unbounded_env(self):
        with self.assertRaises(ValueError):
            mod.env_subset("database")
    def test_03_shared_alias(self):
        self.assertEqual(mod.target_alias({"v3":{}},{"v3":{"Aliases":["db"]}}),"db")
    def test_04_shared_name(self):
        self.assertEqual(mod.target_alias({"v3":{}},{"v3":{"Aliases":[mod.DB]}}),mod.DB)
    def test_05_no_shared(self):
        self.assertIsNone(mod.target_alias({"other":{}},{"v3":{"Aliases":["db"]}}))
    def test_06_no_alias(self):
        self.assertIsNone(mod.target_alias({"v3":{}},{"v3":{"Aliases":["unrelated"]}}))
    def test_07_fail_closed_env(self):
        self.assertEqual(mod.env_subset(["DATABASE_URL=secret"]),{})
    def test_08_pass(self):
        self.assertEqual(mod.safe_rows(b"WORKER_AUTH_SELECT1_PASS\n"),["WORKER_AUTH_SELECT1_PASS"])
    def test_09_fail(self):
        self.assertEqual(mod.safe_rows(b"WORKER_AUTH_SELECT1_FAIL\n"),["WORKER_AUTH_SELECT1_FAIL"])
    def test_10_sqlstate(self):
        self.assertEqual(mod.safe_rows(b"PG_SQLSTATE 28P01\n"),["PG_SQLSTATE 28P01"])
    def test_11_reason(self):
        self.assertEqual(mod.safe_rows(b"PG_FAILURE_CATEGORY PG_PASSWORD_REJECTED\n"),
                         ["PG_FAILURE_CATEGORY PG_PASSWORD_REJECTED"])
    def test_12_bad_reason(self):
        self.assertEqual(mod.safe_rows(b"PG_FAILURE_CATEGORY SUPERSECRET\n"),[])
    def test_13_raw_secret(self):
        self.assertEqual(mod.safe_rows(b"postgresql://user:VERY_PRIVATE@db/mydb\n"),[])
    def test_14_multiline_redaction(self):
        self.assertEqual(mod.safe_rows(b"SERVER_PRIVATE_PASSWORD\nWORKER_AUTH_SELECT1_FAIL\n"),
                         ["WORKER_AUTH_SELECT1_FAIL"])
    def test_15_sql_always_readonly(self):
        self.assertIn('cursor',mod.PROBE)
        self.assertIn('default_transaction_read_only=on',mod.PROBE)
        self.assertIn('SHOW transaction_read_only',mod.PROBE)
        self.assertIn('SELECT 1',mod.PROBE)
        self.assertNotIn('INSERT INTO',mod.PROBE)
        self.assertNotIn('UPDATE ',mod.PROBE)
    def test_16_no_mutation_production(self):
        text=path.read_text()
        for banned in ["docker restart","docker compose up","alembic upgrade",
                       "docker stop","docker rm","print(env)","print(credentials)"]:
            self.assertNotIn(banned,text)
    def test_17_no_secret_argv(self):
        self.assertIn('payload=json.dumps(credentials).encode("utf-8")',path.read_text())
        self.assertIn('"exec","-i"',path.read_text())
    def test_18_driver_missing(self):
        self.assertEqual(mod.safe_rows(b"AUTH_PROBE_DRIVER_MISSING\n"),
                         ["AUTH_PROBE_DRIVER_MISSING"])
    def test_19_bad_sqlstate(self):
        self.assertEqual(mod.safe_rows(b"PG_SQLSTATE aaaaa\n"),[])
    def test_20_safelist_injected(self):
        self.assertEqual(mod.safe_rows(b"WORKER_AUTH_SELECT1_PASS && echo BAD\n"),[])

if __name__=="__main__":
    unittest.main(verbosity=2)
