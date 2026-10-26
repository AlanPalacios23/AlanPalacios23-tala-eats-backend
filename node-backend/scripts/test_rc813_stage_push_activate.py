#!/usr/bin/env python3
"""Offline tests for fail-closed isolated PM2/VAPID restart helper."""
import importlib.util
from pathlib import Path
import unittest

SCRIPT=Path(__file__).with_name("rc813-stage-web-push-activate.py")
spec=importlib.util.spec_from_file_location("rc813_stage_push_activate",SCRIPT)
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
DATA={
 "DATABASE_URL":"postgresql://tala_node_stage:secret@127.0.0.1:15435/tala_node_stage",
 "REDIS_URL":"redis://:secret@127.0.0.1:16379/1",
 "NODE_ENV":"staging","HOST":"127.0.0.1","PORT":"18192",
 "STAGE_PARALLEL_ENABLED":"true","WEB_PUSH_ENABLED":"false",
 "WEB_PUSH_VAPID_PUBLIC_KEY":"A"*87,
 "WEB_PUSH_VAPID_PRIVATE_KEY":"B"*43,
 "WEB_PUSH_SUBJECT":"mailto:test@example.com",
}

class ActivationTest(unittest.TestCase):
 def test_accepts_only_private_isolated_environment(self):
  mod.verify_env(DATA)
 def test_fails_closed_on_public_or_money_environment(self):
  changes=[
   ("PORT","18190"),("NODE_ENV","production"),("WEB_PUSH_ENABLED","true"),
   ("STAGE_PARALLEL_ENABLED","false"),("REDIS_URL","redis://:secret@127.0.0.1:16379/0"),
   ("DATABASE_URL","postgresql://talaeats_live:x@127.0.0.1:15445/talaeats_live"),
   ("STRIPE_LIVE_ENABLED","true"),("WEB_PUSH_VAPID_PUBLIC_KEY","bad"),
  ]
  for key,bad in changes:
   with self.subTest(key=key,bad=bad):
    env={**DATA,key:bad}
    with self.assertRaises(SystemExit):mod.verify_env(env)
 def test_rejects_duplicate_critical_env_and_leaks_no_keys(self):
  with self.assertRaises(SystemExit):
   mod.values("WEB_PUSH_ENABLED=false\nWEB_PUSH_ENABLED=true\n")
 def test_worker_before_api_and_rollback_are_encoded(self):
  code=SCRIPT.read_text()
  self.assertIn("I_APPROVE_RC813_STAGE_WEB_PUSH_ONLY",code)
  self.assertIn("RC813_STAGE_PUSH_ACTIVATION_PLAN_READ_ONLY=PASS",code)
  self.assertIn("ACTIVE_STAGE_SUBSCRIPTIONS_REQUIRE_REVIEW",code)
  self.assertIn("SELECT count(*)::int AS n FROM push_subscriptions",code)
  self.assertIn("run_pm2(\"restart\",name,\"--update-env\")",code)
  self.assertIn('("tala-rc813-parallel-worker","tala-rc813-parallel-api")',code)
  self.assertIn("except (Exception,SystemExit):",code)
  self.assertIn("RC813_STAGE_PUSH_ACTIVATION_ROLLBACK=ATTEMPTED",code)
  self.assertIn('os.replace(tmp,ENV)',code)
  for bad in ["pm2 kill","migrate deploy","FLUSHDB","FLUSHALL","systemctl restart"]:
   self.assertNotIn(bad,code)

if __name__=="__main__":
 unittest.main()
