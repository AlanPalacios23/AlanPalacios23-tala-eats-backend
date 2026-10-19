#!/usr/bin/env python3
"""Isolated redaction and classification unit tests; no Docker, network or SQL."""
import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location("diagnostic",Path(__file__).with_name("kali_v3_pg_root_cause_readonly.py"))
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
class RootCause(unittest.TestCase):
    def test_01_password_rejected(self):
        self.assertIn("AUTH_PASSWORD_REJECTED",m.classify_log_lines(b"FATAL: password authentication failed for user account"))
    def test_02_password_missing(self):
        self.assertIn("AUTH_PASSWORD_ABSENT",m.classify_log_lines(b"fe_sendauth: no password supplied"))
    def test_03_hba_denied(self):
        self.assertIn("AUTH_HBA_DENIED",m.classify_log_lines(b"FATAL: no pg_hba.conf entry for host"))
    def test_04_role_missing(self):
        self.assertIn("ROLE_MISSING",m.classify_log_lines(b'FATAL: role "missing" does not exist'))
    def test_05_database_missing(self):
        self.assertIn("DATABASE_MISSING",m.classify_log_lines(b'FATAL: database "missing" does not exist'))
    def test_06_limit(self):
        self.assertIn("CONNECTION_LIMIT",m.classify_log_lines(b"too many clients already"))
    def test_07_not_accepting(self):
        self.assertIn("DB_NOT_ACCEPTING",m.classify_log_lines(b"database system is starting up"))
    def test_08_network(self):
        self.assertIn("TCP_REFUSED",m.classify_log_lines(b"connection refused"))
    def test_09_ssl(self):
        self.assertIn("SSL_NEGOTIATION_ERROR",m.classify_log_lines(b"SSL error"))
    def test_10_client_param(self):
        self.assertIn("CLIENT_PARAM_ERROR",m.classify_log_lines(b"unrecognized configuration parameter"))
    def test_11_log_no_value(self):
        self.assertNotIn("LEAK_PRIVATE_SECRET",str(m.classify_log_lines(b"LEAK_PRIVATE_SECRET; SQLSTATE 28P01")))
    def test_12_worker_valid(self):
        x=m.safe_worker_output(b"DBAPI_STATUS FAIL\nDBAPI_SQLSTATE 28P01\nDBAPI_REASON AUTH_PASSWORD_REJECTED\n")
        self.assertEqual(x,["DBAPI_STATUS FAIL","DBAPI_SQLSTATE 28P01","DBAPI_REASON AUTH_PASSWORD_REJECTED"])
    def test_13_worker_no_password(self):
        self.assertEqual(m.safe_worker_output(b"DBAPI_PASSWORD_CONFIGURED no\n"),["DBAPI_PASSWORD_CONFIGURED no"])
    def test_14_worker_no_private_data(self):
        self.assertEqual(m.safe_worker_output(b"DB_PASSWORD=SECRET\npsycopg.OperationalError: password=SECRET\n"),[])
    def test_15_invalid_worker_reason(self):
        self.assertEqual(m.safe_worker_output(b"DBAPI_REASON TOKEN_12345\n"),[])
    def test_16_worker_class(self):
        self.assertEqual(m.safe_worker_output(b"DBAPI_CLASS OperationalError\n"),["DBAPI_CLASS OperationalError"])
    def test_17_no_false_pass(self):
        self.assertEqual(m.safe_worker_output(b"DBAPI_STATUS PASS; DROP DATABASE prod\n"),[])
    def test_18_match_declared(self):
        self.assertEqual(m.compare_pg_metadata("postgresql://worker:pw@db/mydb",{"POSTGRES_USER":"worker","POSTGRES_DB":"mydb"}),("yes","yes"))
    def test_19_declared_mismatch(self):
        self.assertEqual(m.compare_pg_metadata("postgresql://worker:pw@db/notdb",{"POSTGRES_USER":"worker","POSTGRES_DB":"mydb"}),("yes","no-or-unknown"))
    def test_20_default_postgres(self):
        self.assertEqual(m.compare_pg_metadata("postgresql://postgres:pw@db/postgres",{}),("yes","yes"))
    def test_21_untrusted_scheme(self):
        self.assertEqual(m.compare_pg_metadata("sqlite:///tmp/local.db",{}),("unknown","unknown"))
    def test_22_only_select(self):
        self.assertIn('cursor.execute("SELECT 1")',m.WORKER_PROGRAM)
        self.assertIn("default_transaction_read_only=on",m.WORKER_PROGRAM)
    def test_23_no_mutation(self):
        src=Path(m.__file__).read_text()
        self.assertNotIn("docker restart",src)
        self.assertNotIn("docker compose",src)
        self.assertNotIn("alembic upgrade",src)
        self.assertNotIn("print(dsn)",src)
        self.assertNotIn("print(error)",src)
if __name__=="__main__":
    unittest.main(verbosity=2)
