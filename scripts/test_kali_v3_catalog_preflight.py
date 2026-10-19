#!/usr/bin/env python3
"""Offline metadata/catalog comparison; no Docker or live DB."""
from pathlib import Path
import importlib.util
import tempfile
import unittest
s=importlib.util.spec_from_file_location("p",Path(__file__).with_name("kali_v3_catalog_preflight.py"))
m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
C={"roles":[{"name":"app","login":True},{"name":"disabled","login":False}],
   "databases":[{"name":"mydb","owner":"app"},{"name":"other","owner":"disabled"}]}
class Tests(unittest.TestCase):
    def test_01_good_role(self):self.assertEqual(m.catalog_flags("app","mydb",C)["ROLE_EXISTS"],"yes")
    def test_02_missing_role(self):self.assertEqual(m.catalog_flags("missing","mydb",C)["ROLE_EXISTS"],"no")
    def test_03_missing_db(self):self.assertEqual(m.catalog_flags("app","missing",C)["DATABASE_EXISTS"],"no")
    def test_04_good_db(self):self.assertEqual(m.catalog_flags("app","mydb",C)["DATABASE_EXISTS"],"yes")
    def test_05_login(self):self.assertEqual(m.catalog_flags("app","mydb",C)["ROLE_CAN_LOGIN"],"yes")
    def test_06_no_login(self):self.assertEqual(m.catalog_flags("disabled","other",C)["ROLE_CAN_LOGIN"],"no")
    def test_07_owner(self):self.assertEqual(m.catalog_flags("app","mydb",C)["DATABASE_OWNER_MATCHES_ROLE"],"yes")
    def test_08_wrong_owner(self):self.assertEqual(m.catalog_flags("disabled","mydb",C)["DATABASE_OWNER_MATCHES_ROLE"],"no")
    def test_09_user_absent(self):self.assertEqual(m.catalog_flags(None,"mydb",C)["ROLE_EXISTS"],"unknown")
    def test_10_database_absent(self):self.assertEqual(m.catalog_flags("app",None,C)["DATABASE_EXISTS"],"unknown")
    def test_11_parse(self):self.assertEqual(m.target_from_url("postgresql+psycopg://app:PW@db:5432/mydb"),("app","mydb"))
    def test_12_encoded_user(self):self.assertEqual(m.target_from_url("postgresql://ap%70:PW@db/mydb"),("app","mydb"))
    def test_13_bad_scheme(self):self.assertEqual(m.target_from_url("sqlite:///tmp/db"),(None,None))
    def test_14_missing_url(self):self.assertEqual(m.target_from_url(""),(None,None))
    def test_15_env(self):self.assertEqual(m.env_value(["A=1","DATABASE_URL=test"],"DATABASE_URL"),"test")
    def test_16_no_env(self):self.assertEqual(m.env_value(["SECRET=hidden"],"DATABASE_URL"),"")
    def test_17_file_absent(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(m.safe_files(d+"/gone.yml"),(1,0,False))
    def test_18_file_present(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"x.yml";p.write_text("test")
            self.assertEqual(m.safe_files(str(p)),(1,1,True))
    def test_19_symlink_blocked(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"x.yml";p.write_text("test")
            q=Path(d)/"y.yml";q.symlink_to(p)
            self.assertEqual(m.safe_files(str(q)),(1,0,False))
    def test_20_empty_config(self):self.assertEqual(m.safe_files(""),(0,0,False))
    def test_21_no_secret_output(self):
        self.assertNotIn("VERY_SECRET",str(m.catalog_flags("app","mydb",C)))
    def test_22_sql_readonly(self):
        self.assertNotIn("INSERT ",m.PG_SQL)
        self.assertNotIn("UPDATE ",m.PG_SQL)
        self.assertNotIn("DELETE ",m.PG_SQL)
        self.assertTrue(m.PG_SQL.lstrip().startswith("SELECT "))
    def test_23_source_no_mutators(self):
        x=Path(m.__file__).read_text()
        for bad in ("docker restart","docker compose up","alembic upgrade","print(url)","print(catalog)"):
            self.assertNotIn(bad,x)
if __name__=="__main__":unittest.main(verbosity=2)
