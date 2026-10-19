#!/usr/bin/env python3
"""No Docker required; verify URL and network checks do not print secrets."""
import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).with_name("kali_v3_config_safe_readonly.py")
s = importlib.util.spec_from_file_location("cfg", path)
cfg = importlib.util.module_from_spec(s)
s.loader.exec_module(cfg)
back = {"v3-network": {}}
db = {"v3-network": {"Aliases": ["db", "talaeats-v3-db-1"]}}
def evaluate(url, b=back, d=db, **kwargs):
    env = ["DATABASE_URL="+url, "ENVIRONMENT=production","AUTO_MIGRATE_ON_START=false","STRIPE_SECRET_KEY=DO_NOT_PRINT"]
    env.extend(k+"="+v for k,v in kwargs.items())
    return cfg.evaluate(env, b, d)
class Safe(unittest.TestCase):
    def test_01_good_host(self):
        self.assertEqual(evaluate("postgresql+psycopg://app:SECRET@db:5432/talaeats")["DB_HOST_MATCH_V3_DB_ALIAS"],"yes")
    def test_02_wrong_host(self):
        self.assertEqual(evaluate("postgresql+psycopg://app:SECRET@another-db:5432/x")["DB_HOST_MATCH_V3_DB_ALIAS"],"no")
    def test_03_no_shared_network(self):
        self.assertEqual(evaluate("postgresql://user:password@db:5432/x", {"other": {}}, db)["DB_HOST_MATCH_V3_DB_ALIAS"],"unknown")
    def test_04_wrong_port(self):
        self.assertEqual(evaluate("postgresql://user:SECRET@db:7654/x")["DB_PORT_EXPECTED_5432"],"no")
    def test_05_default_port(self):
        self.assertEqual(evaluate("postgresql://user:SECRET@db/x")["DB_PORT_EXPECTED_5432"],"yes")
    def test_06_database_url_missing(self):
        self.assertEqual(cfg.evaluate(["ENVIRONMENT=production"],back,db)["DATABASE_URL_PRESENT"],"no")
    def test_07_wrong_scheme(self):
        self.assertEqual(evaluate("sqlite:///tmp/database.db")["DB_SCHEME_POSTGRES"],"no")
    def test_08_invalid_port(self):
        self.assertEqual(evaluate("postgresql://user:SECRET@db:hello/x")["DB_SCHEME_POSTGRES"],"invalid")
    def test_09_migrate_true(self):
        self.assertEqual(evaluate("postgresql://user:pw@db/x",AUTO_MIGRATE_ON_START="true")["AUTO_MIGRATE_FLAG_ON"],"yes")
    def test_10_not_prod(self):
        self.assertEqual(evaluate("postgresql://user:pw@db/x",ENVIRONMENT="development")["ENVIRONMENT_PRODUCTION"],"no-or-unset")
    def test_11_no_env_value_output(self):
        secret="SECRET_PASSWORD_DO_NOT_LEAK"
        self.assertNotIn(secret,str(evaluate("postgresql://user:"+secret+"@db/x")))
    def test_12_unknown_extra_key(self):
        self.assertNotIn("STRIPE_SECRET_KEY",cfg.env_dict(["STRIPE_SECRET_KEY=DO_NOT_PRINT","DATABASE_URL=test"]))
    def test_13_aliases(self):
        shared,aliases=cfg.aliases_on_shared_network(back,db)
        self.assertTrue(shared)
        self.assertIn("db",aliases)
    def test_14_no_network(self):
        self.assertFalse(cfg.aliases_on_shared_network({},db)[0])
if __name__=="__main__":
    unittest.main(verbosity=2)
