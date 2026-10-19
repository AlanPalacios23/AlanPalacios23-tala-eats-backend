#!/usr/bin/env python3
"""No-Docker tests for private V3 restore preview guardrails."""
import importlib.util
from pathlib import Path
import unittest
p=Path(__file__).with_name("kali_v3_prepare_private_restore.py")
sp=importlib.util.spec_from_file_location("restore_prep",p)
m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m)
DB={"POSTGRES_USER":"svc","POSTGRES_PASSWORD":"myPass","POSTGRES_DB":"tala"}
class Test(unittest.TestCase):
    def test_01_pg_correct(self):
        self.assertTrue(m.valid_postgres_url("postgresql+psycopg://svc:myPass@db:5432/tala",DB))
    def test_02_pg_bad_password(self):
        self.assertFalse(m.valid_postgres_url("postgresql://svc:no@db/tala",DB))
    def test_03_pg_bad_host(self):
        self.assertFalse(m.valid_postgres_url("postgresql://svc:myPass@other/tala",DB))
    def test_04_pg_no_user(self):
        self.assertFalse(m.valid_postgres_url("postgresql://db:5432/tala",DB))
    def test_05_pg_no_db(self):
        self.assertFalse(m.valid_postgres_url("postgresql://svc:myPass@db",DB))
    def test_06_pg_template(self):
        self.assertFalse(m.valid_postgres_url("postgresql://$"+"{USER}@db/tala",DB))
    def test_07_redis(self):
        self.assertTrue(m.clean_redis_url("redis://redis:6379/1"))
    def test_08_redis_auth(self):
        self.assertTrue(m.clean_redis_url("redis://:SECRET@redis:6379/1"))
    def test_09_redis_bad_scheme(self):
        self.assertFalse(m.clean_redis_url("http://redis:6379"))
    def test_10_redis_no_host(self):
        self.assertFalse(m.clean_redis_url("redis://:secret@"))
    def test_11_redis_template(self):
        self.assertFalse(m.clean_redis_url("redis://$"+"{REDIS_HOST}:6379"))
    def test_12_dollar_escape(self):
        self.assertEqual(m.literal("abc$de"),'"abc$$de"')
    def test_13_json_quote(self):
        self.assertEqual(m.literal('one"two'),'"one\\"two"')
    def test_14_yaml_only_services(self):
        d={"backend":{"image":"sha256:"+"a"*64,"DATABASE_URL":"postgres://x","REDIS_URL":"redis://x"},
           "worker":{"image":"sha256:"+"b"*64,"DATABASE_URL":"postgres://y","REDIS_URL":"redis://y"}}
        y=m.build_overlay(d)
        self.assertIn("services:",y)
        self.assertIn("image:",y)
        self.assertIn("REDIS_URL:",y)
        self.assertNotIn("db:",y)
        self.assertNotIn("caddy:",y)
    def test_15_no_docker_recreate(self):
        src=p.read_text()
        self.assertNotIn("docker restart",src)
        self.assertNotIn("docker exec",src)
        self.assertNotIn("docker compose up -d",src)
        self.assertNotIn("alembic upgrade",src)
        self.assertIn('"--dry-run"',src)
    def test_16_no_secret_output(self):
        src=p.read_text()
        for bad in ["print(text)","print(desired)","print(base_env)","print(db_env)",
                    "print(p.stdout)","print(dry.stderr)"]:
            self.assertNotIn(bad,src)
    def test_17_private_permissions(self):
        src=p.read_text()
        self.assertIn("os.O_EXCL",src)
        self.assertIn("os.umask(0o077)",src)
        self.assertIn("os.chmod(OUT,0o600)",src)
    def test_18_never_authorizes_production(self):
        self.assertIn("REQUIRES_BACKUP_AND_EXPLICIT_PRODUCTION_AUTHORIZATION",p.read_text())
if __name__=="__main__":
    unittest.main(verbosity=2)
