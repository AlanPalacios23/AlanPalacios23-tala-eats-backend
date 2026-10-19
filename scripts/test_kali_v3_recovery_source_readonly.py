#!/usr/bin/env python3
"""Offline tests of V3 pre-recovery read-only source check."""
import importlib.util
from pathlib import Path
import unittest
p=Path(__file__).with_name("kali_v3_recovery_source_readonly.py")
s=importlib.util.spec_from_file_location("r",p)
r=importlib.util.module_from_spec(s);s.loader.exec_module(r)
class Check(unittest.TestCase):
  def test_01_static_locations(self):
    self.assertEqual(r.DB,"talaeats-v3-db-1")
  def test_02_no_prod_db_writes(self):
    self.assertIn("SELECT 1",p.read_text())
  def test_03_no_restart(self):
    self.assertNotIn("docker restart",p.read_text())
  def test_04_no_compose_mutations(self):
    self.assertNotIn("docker compose up",p.read_text())
  def test_05_no_alembic(self):
    self.assertNotIn("alembic upgrade",p.read_text())
  def test_06_no_env_print(self):
    self.assertNotIn("print(env)",p.read_text())
  def test_07_no_url_print(self):
    self.assertNotIn("print(url)",p.read_text())
  def test_08_no_password_print(self):
    self.assertNotIn("print(db[",p.read_text())
  def test_09_no_sql_output(self):
    self.assertIn('p.stdout.strip()==b"1"',p.read_text())
  def test_10_no_ssh(self):
    self.assertNotIn('"ssh"',p.read_text())
  def test_11_no_proxy_changes(self):
    self.assertNotIn("cloudflared tunnel",p.read_text())
  def test_12_no_new_files(self):
    self.assertNotIn(".write_text(",p.read_text())
if __name__=="__main__":
 unittest.main(verbosity=2)
