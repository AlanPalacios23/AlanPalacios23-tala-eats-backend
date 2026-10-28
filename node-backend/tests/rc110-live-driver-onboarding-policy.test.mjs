import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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
