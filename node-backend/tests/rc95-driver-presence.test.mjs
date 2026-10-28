import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {driverLocationKey,driverPersistKey,canOperateDriverPresence,hasFreshVerifiedDriverGps} from '../src/marketplace/delivery-runtime.ts';

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
 assert.match(source,/const deliveryActions=\(\)=>/);
 assert.match(source,/if\(!liveDispatchReleased\(\)\)fail\(503/);
 assert.match(config,/RC96_LIVE_DELIVERY_NOT_RELEASED_STRIPE_TEST_REQUIRED/);
 assert.match(source,/if\(!p\?\.isVerified\|\|!p\.isOnline\)/);
 assert.match(source,/driverLocationKey\(config.NODE_ENV,actor.id\)/);
 assert.match(source,/driverPersistKey\(config.NODE_ENV,actor.id\)/);
 assert.match(source,/export async function driverAccept\(actor:AuthUser,orderId:number\)\{\n  deliveryActions\(\);/);
 assert.match(source,/export async function driverStatus\(actor:AuthUser,orderId:number,next:string\)\{\n  deliveryActions\(\);/);
 assert.match(source,/export async function driverComplete\(actor:AuthUser,orderId:number,/);
 assert.match(source,/proof:\{pin:string;photo_url\?:string;lat\?:number\|null;lng\?:number\|null\}\)\{\n  deliveryActions\(\);/);
});

test('driver route exposes own readiness without coordinates or accidental delivery enabling',()=>{
 const routes=readFileSync(new URL('../src/marketplace/routes.ts',import.meta.url),'utf8');
 const driver=readFileSync(new URL('../src/marketplace/driver.ts',import.meta.url),'utf8');
 assert.match(routes,/stageDriverRouter\.get\('\/presence-readiness',async\(req,res\)=>\{/);
 assert.match(routes,/const account=await driverAccount\(req\);\s+const result=await driverPresenceReadiness\(account\);/);
 assert.match(routes,/res\.setHeader\('Cache-Control','private, no-store'\);\s+res\.json\(result\);/);
 assert.match(driver,/export async function driverPresenceReadiness\(actor:AuthUser\)/);
 assert.match(driver,/profile\?\.isVerified===true&&actor\.isActive===true/);
 assert.match(driver,/const \[raw,ttl\]=await Promise\.all\(\[redis\.get\(key\),redis\.ttl\(key\)\]\)/);
 assert.match(driver,/live_delivery_checkout_enabled:false/);
 assert.match(driver,/live_stripe_delivery_enabled:false/);
 const section=driver.slice(driver.indexOf('export async function driverPresenceReadiness'),driver.indexOf('export async function canDriverReachPickup'));
 assert.doesNotMatch(section,/await tx\.marketOrder\.|db\.marketOrder\.|stripe\.|order\.create/);
 assert.doesNotMatch(section,/currentLat:|currentLng:|reported_at:parsed\.reported_at/);
});

test('GPS heartbeat expires after 120 seconds and rejects tampering, future data and invalid coordinates',()=>{
 const now=Date.parse('2026-10-28T19:35:00.000Z');
 const location=(lat,lng,when)=>JSON.stringify({lat,lng,reported_at:when});
 assert.equal(hasFreshVerifiedDriverGps(location(20.65,-103.7,new Date(now).toISOString()),120,now),true);
 assert.equal(hasFreshVerifiedDriverGps(location(20.65,-103.7,new Date(now-119000).toISOString()),1,now),true);
 assert.equal(hasFreshVerifiedDriverGps(location(20.65,-103.7,new Date(now-121000).toISOString()),120,now),false);
 assert.equal(hasFreshVerifiedDriverGps(location(20.65,-103.7,new Date(now+1000).toISOString()),120,now),false);
 assert.equal(hasFreshVerifiedDriverGps(location(20.65,-103.7,new Date(now).toISOString()),0,now),false);
 assert.equal(hasFreshVerifiedDriverGps(location(20.65,-103.7,new Date(now).toISOString()),121,now),false);
 assert.equal(hasFreshVerifiedDriverGps(location(95,-103.7,new Date(now).toISOString()),10,now),false);
 assert.equal(hasFreshVerifiedDriverGps(location(20.65,-200,new Date(now).toISOString()),10,now),false);
 assert.equal(hasFreshVerifiedDriverGps('not json',10,now),false);
 assert.equal(hasFreshVerifiedDriverGps(null,10,now),false);
});
