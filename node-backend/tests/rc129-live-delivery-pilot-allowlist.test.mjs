import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  pilotBuyerAndStoreAllowed,pilotDriverAllowed,
} from '../dist/marketplace/live-delivery-pilot.js';

const src=path=>readFileSync(new URL('../src/'+path,import.meta.url),'utf8');

test('RC12.9 LIVE pilot requires exact buyer and seller, never staging',()=>{
 assert.equal(pilotBuyerAndStoreAllowed('production',11,12,11,12),true);
 for(const input of [
   ['staging',11,12,11,12],
   ['production',10,12,11,12],
   ['production',11,10,11,12],
   ['production',11,12,undefined,12],
   ['production',11,12,11,undefined],
   ['production',0,12,0,12],
   ['production',11,12,11,12.1],
 ]){
   assert.equal(pilotBuyerAndStoreAllowed(...input),false);
 }
 assert.equal(pilotDriverAllowed('production',22,22),true);
 assert.equal(pilotDriverAllowed('production',23,22),false);
 assert.equal(pilotDriverAllowed('staging',22,22),false);
 assert.equal(pilotDriverAllowed('production',22,undefined),false);
});

test('RC12.9 pilot is enforced in all LIVE admission paths',()=>{
 const config=src('config.ts'),checkout=src('marketplace/checkout.ts');
 const app=src('app.ts'),driver=src('marketplace/driver.ts');
 const capacity=src('marketplace/live-delivery-capacity.ts');
 const sweep=src('marketplace/live-delivery-dispatch.ts');
 for(const name of ['CUSTOMER_ID','RESTAURANT_ID','DRIVER_ID'])
   assert.match(config,new RegExp('LIVE_DELIVERY_PILOT_'+name));
 assert.match(config,/RC129_LIVE_DELIVERY_PILOT_SCOPE_REQUIRED/);
 assert.match(checkout,/pilotBuyerAndStoreAllowed/);
 assert.match(app,/pilotBuyerAndStoreAllowed/);
 assert.match(driver,/pilotDriverAllowed/);
 assert.match(capacity,/LIVE_DELIVERY_PILOT_DRIVER_ID/);
 assert.match(sweep,/LIVE_DELIVERY_PILOT_RESTAURANT_ID/);
 assert.match(sweep,/LIVE_DELIVERY_PILOT_CUSTOMER_ID/);
});
