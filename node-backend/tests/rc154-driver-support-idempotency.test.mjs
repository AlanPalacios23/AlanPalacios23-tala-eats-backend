import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validDriverSupportPayload,driverSupportQuotaExceeded,
 DRIVER_SUPPORT_CATEGORIES,DRIVER_SUPPORT_MAX_IN_WINDOW,
 DRIVER_SUPPORT_DEDUP_MS,DRIVER_SUPPORT_WINDOW_MS
} from '../dist/platform/driver-support-guard.js';

test('RC154 driver incident categories and exact input limits',()=>{
 for(const category of DRIVER_SUPPORT_CATEGORIES){
  assert.equal(validDriverSupportPayload(category,'Necesito ayuda con esta entrega'),true);
 }
 for(const category of ['random','',null,7,'delivery_issue\n']){
  assert.equal(validDriverSupportPayload(category,'Necesito ayuda con esta entrega'),false);
 }
 assert.equal(validDriverSupportPayload('delivery_issue','Corto'),false);
 assert.equal(validDriverSupportPayload('delivery_issue','x'.repeat(1200)),true);
 assert.equal(validDriverSupportPayload('delivery_issue','x'.repeat(1201)),false);
 assert.equal(validDriverSupportPayload('delivery_issue',' Duda de entrega suficientemente extensa '),false);
 assert.equal(validDriverSupportPayload('delivery_issue',null),false);
});

test('RC154 rate guard never accepts impossible counters',()=>{
 assert.equal(DRIVER_SUPPORT_MAX_IN_WINDOW,8);
 assert.equal(DRIVER_SUPPORT_DEDUP_MS,120000);
 assert.equal(DRIVER_SUPPORT_WINDOW_MS,900000);
 assert.equal(driverSupportQuotaExceeded(0),false);
 assert.equal(driverSupportQuotaExceeded(7),false);
 assert.equal(driverSupportQuotaExceeded(8),true);
 assert.equal(driverSupportQuotaExceeded(100),true);
 assert.equal(driverSupportQuotaExceeded(-1),true);
 assert.equal(driverSupportQuotaExceeded(NaN),true);
 assert.equal(driverSupportQuotaExceeded(7.5),true);
});

test('RC154 route enforces DB-scoped concurrency, OFF flag, order lock, idempotency',()=>{
 const routes=readFileSync(new URL('../src/platform/routes.ts',import.meta.url),'utf8');
 const entry=routes.slice(routes.indexOf("platformRouter.post('/support'"),routes.indexOf('// E4:'));
 assert.match(entry,/if\(account\.role==='driver'\)/);
 assert.match(entry,/if\(config\.DRIVER_ORDER_SUPPORT_ENABLED!=='true'\)/);
 assert.match(entry,/validDriverSupportPayload\(p\.category,p\.message\)/);
 assert.match(entry,/withUserLock\(account\.id,async tx=>/);
 assert.match(entry,/SELECT id FROM orders WHERE id=\$1 FOR UPDATE/);
 assert.match(entry,/mayLinkSupportOrder\(account,order,true\)/);
 assert.match(entry,/tx\.platformSupportTicket\.findFirst/);
 assert.match(entry,/message:p\.message,createdAt:\{gte:new Date\(Date\.now\(\)-DRIVER_SUPPORT_DEDUP_MS\)\}/);
 assert.match(entry,/tx\.platformSupportTicket\.count/);
 assert.match(entry,/driverSupportQuotaExceeded\(count\)/);
 assert.match(entry,/return \{row:previous,replayed:true\}/);
 assert.match(entry,/res\.status\(outcome\.replayed\?200:201\)/);
 assert.match(entry,/mayLinkSupportOrder\(account,order,false\)/);
 assert.doesNotMatch(entry,/STRIPE_/);
 assert.doesNotMatch(entry,/driverStatus\(/);
});
