#!/usr/bin/env python3
"""Pure offline gates: no LIVE Stripe account, Redis, PostgreSQL or PM2 access."""
import importlib.util
from pathlib import Path
import unittest

SOURCE=Path(__file__).with_name("rc813-web-push-live-onepass.py")
spec=importlib.util.spec_from_file_location("rc813_push_live_onepass",SOURCE)
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

GOOD = {
 "NODE_ENV":"production","HOST":"127.0.0.1","PORT":"18190",
 "DATABASE_URL":"postgresql://talaeats_live:password@127.0.0.1:15445/talaeats_live",
 "REDIS_URL":"redis://:password@127.0.0.1:16380/0",
 "STRIPE_FINANCIAL_WRITES_ENABLED":"true","STRIPE_LIVE_ENABLED":"true",
 "STRIPE_LIVE_RELEASE_APPROVED":"true","STRIPE_REFUNDS_ENABLED":"true",
 "STRIPE_MANUAL_SETTLEMENT_APPROVED":"true","STRIPE_CONNECT_TRANSFERS_ENABLED":"false",
 "STRIPE_SECRET_KEY":"sk_live_validxyz","STRIPE_PUBLISHABLE_KEY":"pk_live_validxyz",
 "WEB_PUSH_ENABLED":"false"
}

class LiveWebPushGate(unittest.TestCase):
 def test_live_config_valid(self):
  mod.verify_flags(GOOD)
 def test_stage_or_unapproved_finance_flags_refused(self):
  bads=[
   ("NODE_ENV","staging"),("PORT","18192"),
   ("DATABASE_URL","postgresql://tala_node_stage:password@127.0.0.1:15435/tala_node_stage"),
   ("REDIS_URL","redis://:password@127.0.0.1:16379/1"),
   ("STRIPE_FINANCIAL_WRITES_ENABLED","false"),
   ("STRIPE_LIVE_RELEASE_APPROVED","false"),
   ("STRIPE_CONNECT_TRANSFERS_ENABLED","true"),
   ("STRIPE_SECRET_KEY","sk_test_xyz"),("WEB_PUSH_ENABLED","true"),
   ("WEB_PUSH_VAPID_PRIVATE_KEY","already configured")
  ]
  for key,value in bads:
   with self.subTest(key=key):
    with self.assertRaises(SystemExit):
     mod.verify_flags({**GOOD,key:value})
 def test_duplicate_env_forbidden(self):
  with self.assertRaises(SystemExit):
   mod.env_dict("WEB_PUSH_ENABLED=false\nWEB_PUSH_ENABLED=true\n")
 def test_safe_order(self):
  s=SOURCE.read_text()
  for value in [
    "I_APPROVE_REAL_WEB_PUSH_WITH_LIVE_CUTOVER",
    "LIVE_PUSH_EXISTING_STRIPE_HEALTH=PASS",
    'OLD = "aea74744ba47db2333bcef052b296a7a7ab63eb9"',
    'CANDIDATE = "10f28bcaf63efd3e0ab9dc0366440219da261916"',
    'cmd=["curl","-fsS","--connect-timeout","5","--max-time","15"]',
    "LIVE_WEB_PUSH_CONFIG_HTTP_FAILED",
    "LIVE_PUSH_PRODUCTION_BACKUP_VERIFIED=PASS",
    "LIVE_PUSH_EXACTLY_ONE_MIGRATION=PASS",
    "LIVE_PUSH_FINANCE_READONLY_AUDIT=PASS",
    "I_APPROVE_RC813_EXISTING_LIVE_PM2_CUTOVER",
    "LIVE_PUSH_STRIPE_PAYMENTS_STILL_ON=PASS",
    "restore_env(oldenv)",
    "LIVE_PUSH_BACKEND_ACTIVATION=PASS",
  ]:self.assertIn(value,s)
  self.assertLess(s.index('exact_migration_check()\n before_migration_backup()'),
                  s.index('LIVE_PUSH_ONLY_ADDITIVE_MIGRATION=START'))
  self.assertLess(s.index('before_migration_backup()\n print('),
                  s.index('LIVE_PUSH_ONLY_ADDITIVE_MIGRATION=START'))
  for banned in ["FLUSHALL","FLUSHDB","pm2 kill","migrate reset",
                 "STRIPE_CONNECT_TRANSFERS_ENABLED=true"]:
   self.assertNotIn(banned,s)

if __name__=="__main__":
 unittest.main()
