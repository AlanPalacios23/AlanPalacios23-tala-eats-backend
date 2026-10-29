import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../scripts/rc117-kali-live-public-preflight.mjs',
 import.meta.url),'utf8');
test('RC11.7 public preflight only reads pinned LIVE surfaces',()=>{
 for(const part of ['RELEASE_IDENTITY_MISMATCH','ENV_PERMISSIONS',
  "u.port!=='15445'","u.pathname!=='/tala_node_live'",
  'probeLivePublicSurfaces()','RC117_LAUNCH_APPROVAL=NO',
  'RC117_E2E_COMMERCIAL_PROOF=NOT_VERIFIED','RC117_FINANCIAL_OPERATIONS=NONE'])
  assert.ok(source.includes(part),part);
 assert.doesNotMatch(source,/(?:refunds|transfers|payouts|paymentIntents)\.create\(/);
 assert.doesNotMatch(source,/\.delete\(|\.update\(/);
});
