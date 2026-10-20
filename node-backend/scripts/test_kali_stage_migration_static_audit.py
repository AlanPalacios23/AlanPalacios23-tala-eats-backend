#!/usr/bin/env python3
"""Offline negative/positive tests for the read-only Prisma SQL audit."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

SOURCE = Path(__file__).with_name("kali-stage-migration-static-audit.py")
spec = importlib.util.spec_from_file_location("migration_gate", SOURCE)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

class MigrationAuditTests(unittest.TestCase):
    def audit_one(self, sql):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "migration_lock.toml").write_text('provider = "postgresql"\n')
            for n, text in (("000_initial", "CREATE TABLE users(id INTEGER);"),
                            ("001_next", sql)):
                p = root / n
                p.mkdir()
                (p / "migration.sql").write_text(text)
            return gate.audit(root)

    def test_current_repository_migrations(self):
        result = gate.audit(gate.MIGRATIONS)
        self.assertGreaterEqual(result["migration_count"], 20)
        self.assertEqual(result["hazards"], [])
        self.assertIs(result["database_inspected"], False)
        self.assertIs(result["sql_applied"], False)

    def test_additive_migrations_and_foreign_key_are_allowed(self):
        safe = """CREATE TABLE things (
          id INT, user_id INT REFERENCES users(id) ON DELETE CASCADE
        );
        ALTER TABLE things ADD COLUMN address TEXT NOT NULL DEFAULT '';
        CREATE FUNCTION check_one() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'Never UPDATE users or DELETE FROM users'; END;
        $$;
        """
        self.assertEqual(self.audit_one(safe)["hazards"], [])

    def test_drop_column_and_delete_are_rejected(self):
        result = self.audit_one(
            "ALTER TABLE users DROP COLUMN email;\nDELETE FROM users WHERE id=1;")
        self.assertGreaterEqual(result["hazard_count"], 2)

    def test_drop_table_and_truncate_are_rejected(self):
        result = self.audit_one("DROP TABLE orders;\nTRUNCATE TABLE payments;")
        self.assertGreaterEqual(result["hazard_count"], 2)

    def test_empty_sql_fails_closed(self):
        self.assertEqual(self.audit_one("   ")["hazard_count"], 1)

if __name__ == "__main__":
    unittest.main()
