#!/usr/bin/env python3
"""Pure tests of the saved RC8.13 PM2 dump allowlist; no host services touched."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT=Path(__file__).with_name("rc813-preserve-saved-parallel-pm2.py")
spec=importlib.util.spec_from_file_location("rc813_preservation",SCRIPT)
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ROOT="/home/tala-node-stage/tala-node-releases/"+"a"*40+"/node-backend"
GOOD=[
 {"name":"tala-rc813-parallel-api","pm_exec_path":ROOT+"/dist/server.js",
  "pm_cwd":ROOT,"env":{"NODE_ENV":"staging"}},
 {"name":"tala-rc813-parallel-worker","pm_exec_path":ROOT+"/dist/worker.js",
  "pm_cwd":ROOT,"env":{"NODE_ENV":"staging"}},
]

class PreservationTest(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory()
  self.path=Path(self.temp.name)/"dump.pm2"
 def tearDown(self):
  self.temp.cleanup()
 def write(self,data):
  self.path.write_text(json.dumps(data),encoding="utf-8")
 def test_accepted_two_known_processes(self):
  self.write(GOOD)
  module.validate_dump(self.path)
 def test_duplicate_or_unknown_process_rejected(self):
  for value in ([GOOD[0],GOOD[0]],[GOOD[0],{**GOOD[1],"name":"tala-node-stage-api"}]):
   self.write(value)
   with self.assertRaises(SystemExit): module.validate_dump(self.path)
 def test_live_execution_path_rejected(self):
  for field,value in (("pm_exec_path","/home/tala-node-stage/live/dist/server.js"),
                       ("pm_cwd","/home/tala-node-stage/live")):
   changed={**GOOD[0],field:value}
   self.write([changed,GOOD[1]])
   with self.assertRaises(SystemExit): module.validate_dump(self.path)
 def test_stage_only(self):
  self.write([{**GOOD[0],"env":{"NODE_ENV":"production"}},GOOD[1]])
  with self.assertRaises(SystemExit): module.validate_dump(self.path)
 def test_non_regular_or_malformed(self):
  self.path.write_text("not-json")
  with self.assertRaises(SystemExit): module.validate_dump(self.path)
 def test_script_prohibits_deleting_and_daemon_actions(self):
  source=SCRIPT.read_text()
  self.assertIn("os.rename(HOME, destination)",source)
  self.assertNotIn("shutil.rmtree(",source)
  self.assertNotIn('subprocess.run(["pm2"',source)
  self.assertIn('RC813_PM2_ARCHIVE_PLAN_READ_ONLY=PASS',source)

if __name__=="__main__":
 unittest.main()
