import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {driverLocationKey,driverPersistKey,canOperateDriverPresence} from '../src/marketplace/delivery-runtime.ts';

test('stage and LIVE location keys are disjoint and stable',()=>{
 assert.equal(driverLocationKey('staging',19),'tala:node:stage:driver:19:location');
 assert.equal(driverPersistKey('staging',19),'tala:node:stage:driver:19:persist');
 assert.equal(driverLocationKey('production',19),'tala:node:live:driver:19:location');
 assert.equal(driverPersistKey('production',19),'tala:node:live:driver:19:persist');
 assert.notEqual(driverLocationKey('staging',19),driverLocationKey('production',19));
 assert.notEqual(driverLocationKey('production',19),driverLocationKey('production',20));
 for(const bad of [-1,0,1.2,NaN,Infinity])assert.throws(()=>driverLocationKey('production',bad),/INVALID_DRIVER_ID/);
});
test('presence opt-in is independent of order execution flags',()=>{
 assert.equal(canOperateDriverPresence('staging',true,false),true);
 assert.equal(canOperateDriverPresence('staging',false,true),false);
 assert.equal(canOperateDriverPresence('production',true,false),false);
 assert.equal(canOperateDriverPresence('production',false,true),true);
 assert.equal(canOperateDriverPresence('production',false,false),false);
});
test('LIVE driver check-in never starts dispatch or creates delivery orders',()=>{
 const source=readFileSync(new URL('../src/marketplace/driver.ts',import.meta.url),'utf8');
 const config=readFileSync(new URL('../src/config.ts',import.meta.url),'utf8');
 assert.match(config,/LIVE_DRIVER_PRESENCE_ENABLED: z\.enum\(\['false','true'\]\)\.default\('false'\)/);
 assert.match(config,/STAGING_CANNOT_ENABLE_LIVE_DRIVER_PRESENCE/);
 assert.match(source,/if\(isOnline&&config\.NODE_ENV==='staging'\)await assign/);
 assert.match(source,/const presence=\(\)=>/);
 assert.match(source,/const stage=\(\)=>/);
 assert.match(source,/if\(!p\?\.isVerified\|\|!p\.isOnline\)/);
 assert.match(source,/driverLocationKey\(config.NODE_ENV,actor.id\)/);
 assert.match(source,/driverPersistKey\(config.NODE_ENV,actor.id\)/);
 assert.match(source,/export async function driverAccept\(actor:AuthUser,orderId:number\)\{\n  stage\(\);/);
 assert.match(source,/export async function driverStatus\(actor:AuthUser,orderId:number,next:string\)\{\n  stage\(\);/);
 assert.match(source,/export async function driverComplete\(actor:AuthUser,orderId:number,/);
 assert.match(source,/proof:\{pin:string;photo_url\?:string;lat\?:number\|null;lng\?:number\|null\}\)\{\n  stage\(\);/);
});
