import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {rankFreshLiveDrivers} from '../dist/marketplace/delivery-runtime.js';

const now=Date.now();
const gps=(lat,lng,age=0)=>JSON.stringify({lat,lng,reported_at:new Date(now-age).toISOString()});
test('RC12.5 Python parity: closest fresh online LIVE courier is offered first',()=>{
 const ids=[42,11,70,19,21,31];
 const locations=[
  gps(20.658,-103.71),gps(20.6534,-103.704),gps(21,-105),
  gps(20.654,-103.704,121000),null,'bad-json',
 ];
 const ranked=rankFreshLiveDrivers(ids,locations,
  {lat:20.6534,lng:-103.704},now,8);
 assert.deepEqual(ranked.map(x=>x.userId),[11,42]);
 assert.ok(ranked[0].distance<ranked[1].distance);
 assert.deepEqual(rankFreshLiveDrivers(ids,locations,
   {lat:20.6534,lng:-103.704},now,1).map(x=>x.userId),[11,42]);
});
test('RC12.5 offline, stale, future, invalid or foreign inputs never look fresh',()=>{
 for(const raw of [gps(20.65,-103.7,121000),
  JSON.stringify({lat:20.65,lng:-103.7,reported_at:new Date(now+8000).toISOString()}),
  JSON.stringify({lat:200,lng:-103.7,reported_at:new Date(now).toISOString()}),
  JSON.stringify({lat:20.65,lng:-103.7}),null,''] ){
  assert.deepEqual(rankFreshLiveDrivers([2],[raw],
   {lat:20.65,lng:-103.7},now,8),[]);
 }
 assert.deepEqual(rankFreshLiveDrivers([2],[gps(20.65,-103.7)],
   {lat:95,lng:0},now,8),[]);
 assert.deepEqual(rankFreshLiveDrivers([2],[],
   {lat:20.65,lng:-103.7},now,8),[]);
});
test('RC12.5 deterministic tie selection with numeric user id',()=>{
 const p=gps(20.6534,-103.704);
 assert.deepEqual(rankFreshLiveDrivers([19,5,12],[p,p,p],
  {lat:20.6534,lng:-103.704},now,8).map(x=>x.userId),[5,12,19]);
});
test('RC12.5 LIVE available-courier offers cover CASH and signed CARD independently',()=>{
 const src=readFileSync(new URL('../src/marketplace/driver.ts',import.meta.url),'utf8');
 const start=src.indexOf('export async function liveCashDriverOffers(');
 const end=src.indexOf('export async function driverAccept(',start);
 const offers=src.slice(start,end);
 assert.ok(offers.includes('const cashReleased=liveCashDeliveryReleased()'));
 assert.ok(offers.includes('const cardReleased=liveDispatchReleased()'));
 assert.ok(offers.includes("{paymentMethod:'stripe',paymentStatus:'paid'}"));
 assert.ok(offers.includes('await liveCashDeliveryTenderAllowed(db,order)'));
 assert.ok(offers.includes('await liveDeliveryTenderAllowed(db,order)'));
 assert.ok(!offers.includes('customer:{'));
 assert.ok(!offers.includes('delivery_pin'));
 assert.ok(src.includes('nearby=rankFreshLiveDrivers('));
 assert.ok(src.includes('withProfileLock(p.userId,tx=>assign(tx,p.userId,orderId))'));
});
