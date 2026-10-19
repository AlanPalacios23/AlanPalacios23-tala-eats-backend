#!/usr/bin/env python3
"""Offline tests for read-only V3 base Compose parity checker."""
from pathlib import Path
import importlib.util
import unittest
file=Path(__file__).with_name("kali_v3_base_compose_parity_readonly.py")
s=importlib.util.spec_from_file_location("parity",file)
m=importlib.util.module_from_spec(s)
s.loader.exec_module(m)
D={"POSTGRES_USER":"tala","POSTGRES_DB":"db1","POSTGRES_PASSWORD":"priv"}
class TestParity(unittest.TestCase):
    def test_01_good_components(self):
        x=m.value_state("postgresql+psycopg://tala:priv@db:5432/db1",D)
        self.assertEqual([x[z] for z in ("USER","PASSWORD","DB","HOST_V3")],["yes"]*4)
    def test_02_all_db_matches(self):
        x=m.value_state("postgresql://tala:priv@db/db1",D)
        self.assertEqual([x[z] for z in ("USER_MATCH_DB","PASSWORD_MATCH_DB","NAME_MATCH_DB")],["yes"]*3)
    def test_03_wrong_password(self):
        self.assertEqual(m.value_state("postgresql://tala:bad@db/db1",D)["PASSWORD_MATCH_DB"],"no")
    def test_04_incomplete(self):
        self.assertEqual(m.value_state("postgresql://db:5432",D)["USER"],"no")
    def test_05_template(self):
        self.assertEqual(m.value_state("postgresql://$"+"{DB_USER}:$"+"{PW}@db",D)["USER"],"unknown")
    def test_06_no_db_reference(self):
        self.assertEqual(m.value_state("postgresql://tala:priv@db/db1",{})["PASSWORD_MATCH_DB"],"unknown")
    def test_07_other_host(self):
        self.assertEqual(m.value_state("postgresql://tala:priv@other:5432/db1",D)["HOST_V3"],"no")
    def test_08_other_port(self):
        self.assertEqual(m.value_state("postgresql://tala:priv@db:9999/db1",D)["HOST_V3"],"no")
    def test_09_bad_port(self):
        self.assertEqual(m.value_state("postgresql://tala:priv@db:port/db1",D)["HOST_V3"],"unknown")
    def test_10_secret_not_returned(self):
        self.assertNotIn("priv",str(m.value_state("postgresql://tala:priv@db/db1",D)))
    def test_11_env_restrict_keys(self):
        self.assertNotIn("SECRET_KEY",m.dictionary_env(["SECRET_KEY=secret","DATABASE_URL=postgresql://db"]))
    def test_12_compose_environment_map(self):
        self.assertEqual(m.compose_env({"environment":{"DATABASE_URL":"x"}})["DATABASE_URL"],"x")
    def test_13_compose_environment_list(self):
        self.assertEqual(m.compose_env({"environment":["DATABASE_URL=x"]})["DATABASE_URL"],"x")
    def test_14_live_targets(self):
        self.assertEqual(m.mount_targets_live([{"Destination":"/app/media"}]),{"/app/media"})
    def test_15_compose_targets(self):
        self.assertEqual(m.mount_targets_compose({"volumes":[{"target":"/app/media"}]}),{"/app/media"})
    def test_16_missing_mount(self):
        self.assertEqual(m.mount_targets_compose({}),set())
    def test_17_all_flags_are_fixed(self):
        self.assertTrue(set(m.value_state("postgresql://tala:priv@db/db1",D).values())<={"yes","no","unknown"})
    def test_18_no_changes(self):
        src=file.read_text()
        for op in ("docker compose up","docker restart","docker stop","docker exec",
                   "alembic upgrade","print(data)","print(cfg)","print(current)","print(candidate)"):
            self.assertNotIn(op,src)
if __name__=="__main__":
    unittest.main(verbosity=2)
