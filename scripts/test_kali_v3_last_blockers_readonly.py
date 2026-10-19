#!/usr/bin/env python3
"""Offline redaction and classifier tests for final V3 blockers preflight."""
import importlib.util
from pathlib import Path
import unittest
file=Path(__file__).with_name("kali_v3_last_blockers_readonly.py")
spec=importlib.util.spec_from_file_location("b",file)
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
class Gate(unittest.TestCase):
    def test_01_diff_key(self): self.assertEqual(b.difference_keys({"ABC":"x"},{"ABC":"y"}),["ABC"])
    def test_02_no_diff(self): self.assertEqual(b.difference_keys({"ABC":"x"},{"ABC":"x"}),[])
    def test_03_ignore_db_url(self): self.assertEqual(b.difference_keys({"DATABASE_URL":"password"},{"DATABASE_URL":"other"}),[])
    def test_04_allowlist_names(self): self.assertEqual(b.difference_keys({"SAFE_KEY":"a","bad_name":"b"},{"SAFE_KEY":"b","bad_name":"c"}),["SAFE_KEY"])
    def test_05_no_values(self): self.assertNotIn("TOPSECRET",str(b.difference_keys({"SAFE_KEY":"TOPSECRET"},{"SAFE_KEY":"bad"})))
    def test_06_compose_dryrun(self): self.assertIn("UNSUPPORTED_DRY_RUN",b.classify("unknown flag: --dry-run"))
    def test_07_image_missing(self): self.assertIn("IMAGE_NOT_AVAILABLE",b.classify("No such image: my-app"))
    def test_08_network_missing(self): self.assertIn("UNAVAILABLE_NETWORK",b.classify("network something not found"))
    def test_09_permissions(self): self.assertIn("PERMISSION_DENIED",b.classify("permission denied"))
    def test_10_unclassified(self): self.assertEqual(b.classify("private-secret-TOPSECRET"),[])
    def test_11_output_redaction(self):
        s=file.read_text()
        for bad in ('print(result.stderr)','print(p.stderr)','print(candidate)','print(services)','print(p.stdout)'):
            self.assertNotIn(bad,s)
    def test_12_no_live_actions(self):
        s=file.read_text()
        for bad in ('docker restart','docker stop','docker compose up -d','alembic upgrade','docker exec'):
            self.assertNotIn(bad,s)
        self.assertIn('"--dry-run"',s)
if __name__=="__main__":unittest.main(verbosity=2)
