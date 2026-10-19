#!/usr/bin/env python3
"""Offline tests for V3 API/worker DB auth probe (no Docker and no DB)."""
import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location("probe",Path(__file__).with_name("kali_v3_db_auth_readonly.py"))
probe=importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
class TestAuthProbe(unittest.TestCase):
    def test_01_same_url(self):
        self.assertEqual(probe.compare_urls("postgresql://user:pass@db/x","postgresql://user:pass@db/x"),"yes")
    def test_02_mismatch(self):
        self.assertEqual(probe.compare_urls("postgresql://user:pass@db/x","postgresql://user:other@db/x"),"no")
    def test_03_missing(self):
        self.assertEqual(probe.compare_urls("","whatever"),"missing")
    def test_04_select_pass(self):
        self.assertEqual(probe.sanitized_status(b"DB_SELECT1_PASS\n"),["DB_SELECT1_PASS"])
    def test_05_select_fail(self):
        self.assertEqual(probe.sanitized_status(b"DB_SELECT1_FAIL\n"),["DB_SELECT1_FAIL"])
    def test_06_auth_sqlstate(self):
        self.assertIn("DB_SQLSTATE 28P01",probe.sanitized_status(b"DB_SQLSTATE 28P01\n"))
    def test_07_db_absent_sqlstate(self):
        self.assertIn("DB_SQLSTATE 3D000",probe.sanitized_status(b"DB_SQLSTATE 3D000\n"))
    def test_08_overloaded_sqlstate(self):
        self.assertIn("DB_SQLSTATE 53300",probe.sanitized_status(b"DB_SQLSTATE 53300\n"))
    def test_09_exception_type(self):
        self.assertIn("DB_EXCEPTION_CLASS OperationalError",probe.sanitized_status(b"DB_EXCEPTION_CLASS OperationalError\n"))
    def test_10_cannot_leak_url(self):
        self.assertFalse(probe.sanitized_status(b"postgresql://admin:REAL_PASSWORD@db/x\n"))
    def test_11_cannot_leak_stderr(self):
        self.assertFalse(probe.sanitized_status(b"OperationalError: password=REAL_PASSWORD\n"))
    def test_12_reject_injected_line(self):
        self.assertEqual(probe.sanitized_status(b"DB_SELECT1_PASS;rm -rf /\n"),[])
    def test_13_reject_bad_sqlstate(self):
        self.assertEqual(probe.sanitized_status(b"DB_SQLSTATE PASSWORD"),[])
    def test_14_reject_weird_class(self):
        self.assertEqual(probe.sanitized_status(b"DB_EXCEPTION_CLASS OperationalError: password=SECRET"),[])
    def test_15_multiline_safe(self):
        self.assertEqual(probe.sanitized_status(b"SECRET=\nDB_SELECT1_FAIL\nDB_EXCEPTION_CLASS OperationalError\n"),
                         ["DB_SELECT1_FAIL","DB_EXCEPTION_CLASS OperationalError"])
    def test_16_reject_lower_sqlstate(self):
        self.assertEqual(probe.sanitized_status(b"DB_SQLSTATE abc12\n"),[])
    def test_17_fail_safe_prefix(self):
        self.assertEqual(probe.sanitized_status(b"DB_SELECT1_PASS X\n"),[])
    def test_18_source_no_docker_mutation(self):
        script=Path(probe.__file__).read_text()
        self.assertIn('conn.exec_driver_sql("SELECT 1")',script)
        self.assertIn('default_transaction_read_only=on',script)
        self.assertNotIn("docker restart",script)
        self.assertNotIn("docker stop",script)
        self.assertNotIn("alembic upgrade",script)
if __name__=="__main__":
    unittest.main(verbosity=2)
