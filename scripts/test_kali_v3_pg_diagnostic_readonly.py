#!/usr/bin/env python3
"""Offline checks for privacy and precision of the V3 DB failure diagnostic."""
import importlib.util
from pathlib import Path
import unittest
p=Path(__file__).with_name("kali_v3_pg_diagnostic_readonly.py")
s=importlib.util.spec_from_file_location("v3diagnostic",p)
m=importlib.util.module_from_spec(s)
s.loader.exec_module(m)
class Diagnoses(unittest.TestCase):
    def test_password(self):
        self.assertIn("AUTH_FAILED",m.classify("FATAL: password authentication failed for user alan"))
    def test_bad_hostname(self):
        self.assertIn("DNS_FAILED",m.classify('could not translate host name "db" to address'))
    def test_refused(self):
        self.assertIn("TCP_CONNECTION_REFUSED",m.classify("connection refused"))
    def test_missing_db(self):
        self.assertIn("DATABASE_MISSING",m.classify('database "tala" does not exist'))
    def test_no_hba(self):
        self.assertIn("PG_HBA_REJECTED",m.classify("no pg_hba.conf entry for host"))
    def test_missing_role(self):
        self.assertIn("ROLE_MISSING",m.classify('role "foo" does not exist'))
    def test_pg_overload(self):
        self.assertIn("POSTGRES_TOO_MANY_CONNECTIONS",m.classify("remaining connection slots are reserved"))
    def test_starting(self):
        self.assertIn("POSTGRES_STARTING",m.classify("the database system is starting up"))
    def test_schema_drift(self):
        self.assertIn("ALEMBIC_SCHEMA_DRIFT",m.classify("relation x already exists"))
    def test_alembic_revision(self):
        self.assertIn("ALEMBIC_MISSING_REVISION",m.classify("Can't locate revision identified by 'a'"))
    def test_missing_driver(self):
        self.assertIn("POSTGRES_DIALECT_MISSING",m.classify("No module named psycopg"))
    def test_timeout(self):
        self.assertIn("NETWORK_TIMEOUT",m.classify("connection timed out"))
    def test_permission(self):
        self.assertIn("SCHEMA_OR_ROLE_PERMISSION",m.classify("permission denied for schema public"))
    def test_fallback(self):
        self.assertIn("SQLALCHEMY_OPERATIONAL_ERROR",m.classify("sqlalchemy.exc.OperationalError"))
    def test_no_arbitrary_log_exposure(self):
        secret="my-password-test-SENTINEL-not-safe"
        self.assertNotIn(secret," ".join(m.classify("OperationalError: "+secret)))
    def test_no_unrecognized(self):
        self.assertEqual(m.classify("some random text"),[])
    def test_known_output_only(self):
        self.assertTrue(set(m.classify("OperationalError: password authentication failed")).
                        issubset({name for name,_ in (*m.ERRORS,*m.FALLBACK)}))
if __name__=="__main__":unittest.main(verbosity=2)
