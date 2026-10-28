import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {validDriverVehiclePlate} from '../src/operational/driver-onboarding-policy.ts';

const routes=readFileSync(new URL('../src/operational/routes.ts',import.meta.url),'utf8');
test('production driver registration accepts motorized plates and plate-free bicycles',()=>{
 for(const v of ['Motocicleta','Automóvil']){
  for(const plate of ['ABC-1234','xyz 987','A1B2'])assert.equal(validDriverVehiclePlate(v,plate),true);
  for(const plate of ['', '  ', 'AB', 'AB/123', 'INVALIDXX-12345','AB  C1'])
   assert.equal(validDriverVehiclePlate(v,plate),false,v+':'+plate);
 }
 assert.equal(validDriverVehiclePlate('Bicicleta',''),true);
 assert.equal(validDriverVehiclePlate('Bicicleta','ABC-123'),false);
 assert.equal(validDriverVehiclePlate('Patín',''),false);
 assert.equal(validDriverVehiclePlate(undefined,'ABCD'),false);
});
test('LIVE onboarding capabilities are determined by real SQL schema, not claimed optimistically',()=>{
 const cap=routes.split("operationsRouter.get('/onboarding-capabilities'")[1]
  ?.split("operationsRouter.post('/onboarding'")[0]??'';
 assert.match(cap,/information_schema\.columns/);
 assert.match(cap,/table_name='onboarding_applications' AND column_name='plate'/);
 assert.match(cap,/table_name='driver_profiles' AND column_name='plate'/);
 assert.match(cap,/current_schema\(\)/);
 assert.match(cap,/rows\[0\]\?\.supported!==true/);
 assert.match(cap,/res\.status\(503\)\.json\(\{driver_plate_supported:false/);
 assert.match(cap,/Cache-Control','no-store'/);
});
test('both applicant and admin approval enforce the same server-side plate policy',()=>{
 const submit=routes.split("operationsRouter.post('/onboarding'")[1]
  ?.split("operationsRouter.get('/onboarding/mine'")[0]??'';
 const approval=routes.split("operationsRouter.patch('/admin/onboarding/:applicationId'")[1]
  ?.split("operationsRouter.post('/admin/zones'")[0]??'';
 assert.match(submit,/validDriverVehiclePlate\(p\.vehicle,p\.plate\)/);
 assert.match(submit,/bad\(422/);
 assert.match(approval,/validDriverVehiclePlate\(old\.vehicle,old\.plate\)/);
 assert.match(approval,/bad\(409/);
 assert.match(approval,/await account\(req,\['admin'\]\)/);
 assert.ok(!submit.includes('isVerified:true'));
});

test('operator preflight only reads the isolated LIVE schema and cannot change financial flags',()=>{
 const script=readFileSync(new URL('../scripts/rc110-live-driver-onboarding-readonly.mjs',import.meta.url),'utf8');
 for(const required of ["NODE_ENV!=='production'","const LIVE_PORT='15445'","const LIVE_DATABASE='tala_node_live'","url.port!==LIVE_PORT","url.pathname!=='/'+LIVE_DATABASE","BEGIN READ ONLY","ROLLBACK","information_schema.columns","RC110_LIVE_DRIVER_SIGNUP=HOLD_SCHEMA_MIGRATION_PENDING"]){
  assert.ok(script.includes(required),required);
 }
 for(const forbidden of ['ALTER TABLE','DROP TABLE','prisma migrate deploy','pm2 restart','stripe.transfers.create','COMMIT','process.env.LIVE_DELIVERY_DISPATCH_ENABLED=']){
  assert.ok(!script.includes(forbidden),forbidden);
 }
});

test('strict route inventory admits only the read-only driver capabilities endpoint',()=>{
 const inventory=readFileSync(new URL('../scripts/node_route_coverage.py',import.meta.url),'utf8');
 assert.match(inventory,/RC110_ONBOARDING_CAPABILITIES_NODE_ONLY/);
 assert.match(inventory,/\("GET", "\/api\/v1\/operations\/onboarding-capabilities"\)/);
 assert.match(inventory,/observed != \(ADMIN_NODE_ONLY/);
 assert.match(inventory,/Unapproved Node-only route delta/);
});

test('LIVE plate migration requires exact target DB, one pending migration and backup receipt',()=>{
 const op=readFileSync(new URL('../scripts/rc110-kali-live-driver-plate-migration.mjs',import.meta.url),'utf8');
 const syntax=spawnSync(process.execPath,['--check',new URL('../scripts/rc110-kali-live-driver-plate-migration.mjs',import.meta.url).pathname],{encoding:'utf8'});
 assert.equal(syntax.status,0,syntax.stderr);
 for(const required of [
  "I_APPROVE_RC110_ONE_PLATE_COLUMN_ONLY","process.env.NODE_ENV!=='production'",
  "url.port!=='15445'","url.pathname!=='/tala_node_live'",
  "20261028_rc97_driver_plate_registration",
  "missing.length===1&&missing[0]===name",
  "BEGIN READ ONLY","ROLLBACK","pg_dump","pg_restore",
  "receipt.sha!==sha","receipt.digest!==await archiveHash(receipt.archive)",
  "'migrate','deploy'","RC110_SCHEMA_VERIFY=PASS"
 ])assert.ok(op.includes(required),required);
 assert.doesNotMatch(op,/DROP TABLE|DROP DATABASE|prisma migrate reset|stripe\\.transfers\\.create/);
});
