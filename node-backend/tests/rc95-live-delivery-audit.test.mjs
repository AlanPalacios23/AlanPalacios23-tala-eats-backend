import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const url=new URL('../scripts/rc95-live-delivery-readiness-audit.mjs',import.meta.url);
const code=readFileSync(url,'utf8');
test('RC95 readonly audit reports NO-GO on current live release',()=>{
 const result=spawnSync(process.execPath,[url.pathname,'--source'],{
  cwd:new URL('..',import.meta.url).pathname,encoding:'utf8',timeout:8000,
 });
 assert.equal(result.status,2,result.stderr);
 for(const name of [
 'RC95_PRODUCTION_DELIVERY_FEATURE_FLAG=HOLD',
 'RC95_LIVE_DELIVERY_CHECKOUT=HOLD',
 'RC95_LIVE_GPS_NAMESPACE=SOURCE_GUARD_CLEARED',
 'RC95_LIVE_DRIVER_PRESENCE_MOBILE_E2E=HOLD',
 'RC95_LIVE_READY_DISPATCH=HOLD',
 'RC95_LIVE_DRIVER_TENDER_PROOF=HOLD',
 'RC95_LIVE_DISPATCH_WORKER=HOLD',
 'RC95_DELIVERY_EXTERNAL_PROVIDER_AND_DEVICE_E2E=HOLD',
 'RC95_LIVE_RECONCILIATION_AND_OPERATOR_RELEASE=HOLD',
 'RC95_DELIVERY_SOURCE_READINESS=NO_GO',
 'RC95_SOURCE_INSPECTION=PASS_READ_ONLY']){
  assert.match(result.stdout,new RegExp(name));
 }
});
test('RC95 only allows the documented modes and never claims LIVE enabled',()=>{
 const result=spawnSync(process.execPath,[url.pathname,'--apply'],{
  cwd:new URL('..',import.meta.url).pathname,encoding:'utf8',timeout:8000,
 });
 assert.equal(result.status,64);
 assert.match(result.stderr,/USAGE/);
 assert.doesNotMatch(code,/payouts\.create\s*\(|transfers\.create\s*\(|migrate deploy|DROP DATABASE|ALTER TABLE/);
 assert.match(code,/RC95_DELIVERY_LIVE_RELEASE=HOLD/);
 assert.doesNotMatch(code,/RC95_DELIVERY_LIVE_RELEASE=ENABLED/);
});
