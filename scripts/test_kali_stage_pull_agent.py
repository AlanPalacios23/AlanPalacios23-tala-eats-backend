#!/usr/bin/env python3
"""Offline approval/CI guards, no GitHub access, DB access or deployment."""
import importlib.util
from datetime import datetime,timezone
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location("agent",Path(__file__).with_name("kali_stage_pull_agent.py"))
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
SHA="a"*40
NOW=datetime(2026,10,18,18,tzinfo=timezone.utc)
def approval(**changes):
    v={"id":123,"actor":{"login":"AlanPalacios23"},"event":"workflow_dispatch",
       "head_branch":"main","head_sha":SHA,"status":"completed",
       "conclusion":"success","created_at":"2026-10-18T17:30:00Z"}
    v.update(changes);return v
def checks():
    return [dict(id=n+1,name=k,head_sha=SHA,status="completed",conclusion="success",
                 app={"slug":"github-actions"}) for n,k in enumerate(sorted(a.CHECKS))]
class Gate(unittest.TestCase):
    def pick(self,v,last=0):
        return a.select_approval([v],SHA,last,NOW)
    def test_01_owner(self):self.assertIsNotNone(self.pick(approval()))
    def test_02_wrong_actor(self):self.assertIsNone(self.pick(approval(actor={"login":"attacker"})))
    def test_03_wrong_branch(self):self.assertIsNone(self.pick(approval(head_branch="feature")))
    def test_04_wrong_sha(self):self.assertIsNone(self.pick(approval(head_sha="b"*40)))
    def test_05_failed_run(self):self.assertIsNone(self.pick(approval(conclusion="failure")))
    def test_06_pending_run(self):self.assertIsNone(self.pick(approval(status="queued")))
    def test_07_wrong_event(self):self.assertIsNone(self.pick(approval(event="pull_request")))
    def test_08_old_approval(self):self.assertIsNone(self.pick(approval(created_at="2026-10-18T05:00:00Z")))
    def test_09_replayed(self):self.assertIsNone(self.pick(approval(),123))
    def test_10_future_time(self):self.assertIsNone(self.pick(approval(created_at="2026-10-18T20:00:00Z")))
    def test_11_latest_id(self):self.assertEqual(a.select_approval([approval(id=123),approval(id=124)],SHA,0,NOW)["id"],124)
    def test_12_all_checks(self):self.assertTrue(a.checks_pass(checks(),SHA))
    def test_13_missing_check(self):self.assertFalse(a.checks_pass(checks()[:-1],SHA))
    def test_14_failed_check(self):
        x=checks();x[0]["conclusion"]="failure";self.assertFalse(a.checks_pass(x,SHA))
    def test_15_incomplete_check(self):
        x=checks();x[0]["status"]="in_progress";self.assertFalse(a.checks_pass(x,SHA))
    def test_16_wrong_check_sha(self):
        x=checks();x[0]["head_sha"]="b"*40;self.assertFalse(a.checks_pass(x,SHA))
    def test_17_untrusted_provider(self):
        x=checks();x[0]["app"]["slug"]="attacker";self.assertFalse(a.checks_pass(x,SHA))
    def test_18_latest_failed_check(self):
        x=checks();x.append(dict(x[0],id=999,conclusion="failure"));self.assertFalse(a.checks_pass(x,SHA))
    def test_19_reject_empty(self):self.assertFalse(a.checks_pass([],SHA))
    def test_20_bool_id(self):self.assertIsNone(self.pick(approval(id=True)))
if __name__=="__main__":unittest.main(verbosity=2)
