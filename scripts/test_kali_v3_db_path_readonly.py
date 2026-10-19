#!/usr/bin/env python3
"""Offline safety gates for read-only Kali V3 network/DB path diagnostic."""
import importlib.util
from pathlib import Path
import unittest
s=importlib.util.spec_from_file_location("v3",Path(__file__).with_name("kali_v3_db_path_readonly.py"))
m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
class SafeProbe(unittest.TestCase):
    def test_01_network_shared(self):
        self.assertTrue(m.network_state({"v3":{}},{"v3":{"Aliases":["db","talaeats-v3-db-1"]}})[0])
    def test_02_network_separate(self):
        self.assertFalse(m.network_state({"another":{}},{"v3":{"Aliases":["db"]}})[0])
    def test_03_alias_db(self):
        self.assertIn("db",m.network_state({"v3":{}},{"v3":{"Aliases":["db"]}})[1])
    def test_04_alias_fixed(self):
        self.assertIn("talaeats-v3-db-1",m.network_state({"v3":{}},{"v3":{}})[1])
    def test_05_disallow_unshared_alias(self):
        self.assertEqual(m.network_state({"a":{}},{"b":{"Aliases":["db"]}})[1],set())
    def test_06_extract_url(self):
        self.assertEqual(m.configured_url(["APP=ok","DATABASE_URL=postgresql://a:p@db/db"]),"postgresql://a:p@db/db")
    def test_07_no_url(self):
        self.assertEqual(m.configured_url(["SOME_SECRET=q"]), "")
    def test_08_pass(self):
        self.assertEqual(m.parse_allowed_rows(b"DNS_STATUS PASS\nTCP_STATUS PASS\nSQL_STATUS PASS\n"),
                         ["DNS_STATUS PASS","TCP_STATUS PASS","SQL_STATUS PASS"])
    def test_09_bad_password(self):
        self.assertIn("FAIL_KIND AUTH_FAILED",m.parse_allowed_rows(b"FAIL_KIND AUTH_FAILED\n"))
    def test_10_socket_refused(self):
        self.assertIn("FAIL_KIND TCP_REFUSED",m.parse_allowed_rows(b"FAIL_KIND TCP_REFUSED\n"))
    def test_11_sqlstate(self):
        self.assertIn("DB_SQLSTATE 28P01",m.parse_allowed_rows(b"DB_SQLSTATE 28P01\n"))
    def test_12_never_print_url(self):
        self.assertEqual(m.parse_allowed_rows(b"postgresql://admin:SUPERSECRET@db/tala\n"),[])
    def test_13_never_print_exception_text(self):
        self.assertEqual(m.parse_allowed_rows(b"OperationalError: password=SECRET\n"),[])
    def test_14_reject_injected(self):
        self.assertEqual(m.parse_allowed_rows(b"SQL_STATUS PASS; delete database\n"),[])
    def test_15_reject_unknown_kind(self):
        self.assertEqual(m.parse_allowed_rows(b"FAIL_KIND PRIVATE_PASSWORD\n"),[])
    def test_16_reject_bad_sqlstate(self):
        self.assertEqual(m.parse_allowed_rows(b"DB_SQLSTATE SECRET\n"),[])
    def test_17_wrapper_category(self):
        self.assertEqual(m.parse_allowed_rows(b"WRAPPER_KIND DNS_ERROR\n"),["WRAPPER_KIND DNS_ERROR"])
    def test_18_allowlisted_only(self):
        self.assertEqual(m.parse_allowed_rows(b"FATAL: password authentication failed\nSQL_STATUS FAIL\n"),
                         ["SQL_STATUS FAIL"])
    def test_19_query_readonly(self):
        self.assertIn('conn.exec_driver_sql("SELECT 1")',m.WORKER_CODE)
        self.assertIn('default_transaction_read_only=on',m.WORKER_CODE)
    def test_20_no_write_api(self):
        src=Path(m.__file__).read_text()
        for op in ('docker restart','docker stop','docker compose up','docker exec -i',
                   'alembic upgrade', 'print(url)', 'print(e)', 'print(result.stderr)'):
            self.assertNotIn(op,src)
if __name__=="__main__":
    unittest.main(verbosity=2)
