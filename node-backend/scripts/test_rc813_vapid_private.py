#!/usr/bin/env python3
"""Unit/static safety gates for VAPID-only private configuration."""
import importlib.util
import os
from pathlib import Path
import unittest

SCRIPT=Path(__file__).with_name('rc813-stage-vapid-private.py')
spec=importlib.util.spec_from_file_location('stage_vapid_private',SCRIPT)
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

ENV='''NODE_ENV=staging
HOST=127.0.0.1
PORT=18192
STAGE_PARALLEL_ENABLED=true
DATABASE_URL=postgresql://tala_node_stage:password@127.0.0.1:15435/tala_node_stage
REDIS_URL=redis://:password@127.0.0.1:16379/1
STRIPE_FINANCIAL_WRITES_ENABLED=false
STRIPE_LIVE_ENABLED=false
STRIPE_CONNECT_TRANSFERS_ENABLED=false
WEB_PUSH_ENABLED=false
'''

class VapidPrivateTest(unittest.TestCase):
    def test_minimal_valid_stage_config(self):
        cfg=mod.parse_env(ENV)
        mod.check_stage_config(cfg)
        self.assertFalse(mod.keys_present(cfg))
    def test_live_url_rejected(self):
        for original,new in [
            ('PORT=18192','PORT=18190'),
            (':15435/tala_node_stage',':15445/talaeats_live'),
            (':16379/1',':16379/0'),
            ('NODE_ENV=staging','NODE_ENV=production'),
            ('STRIPE_LIVE_ENABLED=false','STRIPE_LIVE_ENABLED=true'),
            ('WEB_PUSH_ENABLED=false','WEB_PUSH_ENABLED=true')
        ]:
            with self.subTest(new=new):
                cfg=mod.parse_env(ENV.replace(original,new))
                with self.assertRaises(SystemExit):mod.check_stage_config(cfg)
    def test_duplicates_and_partial_vapid_fail_closed(self):
        with self.assertRaises(SystemExit):
            mod.parse_env(ENV+'WEB_PUSH_ENABLED=false\n')
        with self.assertRaises(SystemExit):
            mod.keys_present(mod.parse_env(ENV+'WEB_PUSH_VAPID_PUBLIC_KEY=x\n'))
    def test_source_never_enables_service_or_modifies_pm2(self):
        c=SCRIPT.read_text(encoding='utf-8')
        self.assertIn('WEB_PUSH_ENABLED=false',c)
        self.assertIn('RC813_NO_PM2_RESTART=YES',c)
        self.assertIn('I_APPROVE_STAGE_VAPID_CONFIG_ONLY',c)
        self.assertIn('os.O_NOFOLLOW',c)
        self.assertIn('os.replace(tmp, ENV)',c)
        for banned in ['pm2 restart','pm2 start','FLUSHDB','FLUSHALL',
                       'migrate deploy','systemctl restart',
                       'WEB_PUSH_ENABLED=true\\n']:
            self.assertNotIn(banned,c)

if __name__=='__main__':
    unittest.main()
