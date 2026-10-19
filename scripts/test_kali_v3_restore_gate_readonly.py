#!/usr/bin/env python3
"""Offline safety fixtures for one-pass, read-only V3 restore gate."""
from pathlib import Path
import importlib.util
import unittest
path=Path(__file__).with_name("kali_v3_restore_gate_readonly.py")
s=importlib.util.spec_from_file_location("gate",path);g=importlib.util.module_from_spec(s);s.loader.exec_module(g)
DB={"POSTGRES_USER":"app","POSTGRES_PASSWORD":"priv","POSTGRES_DB":"appdb"}
class TestGate(unittest.TestCase):
    def test_01_valid_db(self):
        self.assertTrue(g.url_matches("postgresql+psycopg://app:priv@db:5432/appdb",DB))
    def test_02_missing_user(self):
        self.assertFalse(g.url_matches("postgresql://db:5432/appdb",DB))
    def test_03_missing_password(self):
        self.assertFalse(g.url_matches("postgresql://app@db/appdb",DB))
    def test_04_missing_db(self):
        self.assertFalse(g.url_matches("postgresql://app:priv@db",DB))
    def test_05_wrong_db(self):
        self.assertFalse(g.url_matches("postgresql://app:priv@db/wrong",DB))
    def test_06_wrong_password(self):
        self.assertFalse(g.url_matches("postgresql://app:wrong@db/appdb",DB))
    def test_07_wrong_host(self):
        self.assertFalse(g.url_matches("postgresql://app:priv@prod.example.com/appdb",DB))
    def test_08_template_blocked(self):
        self.assertFalse(g.url_matches("postgresql://$"+"{USER}@db/appdb",DB))
    def test_09_net_resolved(self):
        svc={"networks":{"internal":None}}
        nets={"internal":{"name":"talaeats-v3_default"}}
        self.assertEqual(g.expected_networks(svc,nets),{"talaeats-v3_default"})
    def test_10_net_default(self):
        self.assertEqual(g.expected_networks({},{}),{"talaeats-v3_default"})
    def test_11_live_volume(self):
        mounts=[{"Type":"volume","Destination":"/app/media","Name":"talaeats-v3_media","RW":True}]
        self.assertEqual(g.mounted_live(mounts),{("volume","/app/media","talaeats-v3_media",False)})
    def test_12_compose_volume(self):
        svc={"volumes":[{"type":"volume","source":"media","target":"/app/media"}]}
        self.assertEqual(g.mounted_candidate(svc,{"media":{"name":"talaeats-v3_media"}}),
                         {("volume","/app/media","talaeats-v3_media",False)})
    def test_13_readonly_bind(self):
        svc={"volumes":[{"type":"bind","source":"/safe/data","target":"/app/static","read_only":True}]}
        self.assertEqual(g.mounted_candidate(svc,{}),{("bind","/app/static","/safe/data",True)})
    def test_14_env_parses(self):
        self.assertEqual(g.env_map(["A=b=c","DB_HOST=db"])["A"],"b=c")
    def test_15_no_value_reporting(self):
        self.assertNotIn("priv",str(g.url_matches("postgresql://app:priv@db/appdb",DB)))
    def test_16_no_mutations(self):
        src=path.read_text()
        for term in ('["docker","compose","up"', "docker restart", "alembic upgrade",
                     "docker exec", "docker stop", "docker rm", "print(candidate_env)","print(current_env)"):
            self.assertNotIn(term,src)
    def test_17_force_dryrun(self):
        src=path.read_text()
        self.assertIn('"--dry-run"',src)
        self.assertIn('"--no-deps"',src)
        self.assertIn('"--no-build"',src)
        self.assertIn('"--pull","never"',src)
    def test_18_no_live_automatic_authorization(self):
        self.assertIn('"PRODUCTION_RELEASE_AUTHORIZED no"',path.read_text())
if __name__=="__main__":
    unittest.main(verbosity=2)
