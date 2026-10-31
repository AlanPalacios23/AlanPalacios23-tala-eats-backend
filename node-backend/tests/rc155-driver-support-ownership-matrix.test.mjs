import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mayLinkSupportOrder} from '../dist/platform/support-order-access.js';
import {validDriverSupportPayload,driverSupportQuotaExceeded,
 DRIVER_SUPPORT_MAX_IN_WINDOW} from '../dist/platform/driver-support-guard.js';

const customer={id:103,role:'customer'};
const assignedDriver={id:201,role:'driver'};
const otherDriver={id:202,role:'driver'};
const merchant={id:301,role:'restaurant'};
const admin={id:401,role:'admin'};
const assignedDelivery={userId:customer.id,driverId:assignedDriver.id,orderType:'delivery'};

test('RC155: two drivers plus buyer/merchant/admin cannot impersonate an order actor',()=>{
 const matrix=[
  {actor:assignedDriver,order:assignedDelivery,on:true,expected:true},
  {actor:assignedDriver,order:assignedDelivery,on:false,expected:false},
  {actor:otherDriver,order:assignedDelivery,on:true,expected:false},
  {actor:otherDriver,order:assignedDelivery,on:false,expected:false},
  {actor:customer,order:assignedDelivery,on:false,expected:true},
  {actor:customer,order:assignedDelivery,on:true,expected:true},
  {actor:merchant,order:assignedDelivery,on:true,expected:false},
  {actor:merchant,order:assignedDelivery,on:false,expected:false},
  {actor:admin,order:assignedDelivery,on:false,expected:true},
  {actor:admin,order:null,on:true,expected:false},
  {actor:assignedDriver,order:{...assignedDelivery,driverId:null},on:true,expected:false},
  {actor:assignedDriver,order:{...assignedDelivery,orderType:'pickup'},on:true,expected:false},
  {actor:assignedDriver,order:{...assignedDelivery,driverId:otherDriver.id},on:true,expected:false},
  {actor:otherDriver,order:{...assignedDelivery,driverId:otherDriver.id},on:true,expected:true},
  // A courier whose ID also matches userId cannot exploit buyer ownership.
  {actor:{id:103,role:'driver'},order:assignedDelivery,on:true,expected:false},
  {actor:{id:103,role:'driver'},order:assignedDelivery,on:false,expected:false},
  {actor:{id:0,role:'driver'},order:assignedDelivery,on:true,expected:false},
  {actor:{id:-1,role:'admin'},order:assignedDelivery,on:true,expected:false},
  {actor:{id:NaN,role:'driver'},order:assignedDelivery,on:true,expected:false},
 ];
 for(const [i,entry] of matrix.entries()){
  assert.equal(mayLinkSupportOrder(entry.actor,entry.order,entry.on),
   entry.expected,'matrix row '+(i+1));
 }
});

test('RC155: driver role is never granted a link by randomized foreign order IDs',()=>{
 for(let orderId=1;orderId<=150;orderId++){
  const order={...assignedDelivery,userId:orderId+500,driverId:orderId+600};
  assert.equal(mayLinkSupportOrder(assignedDriver,order,true),false);
  assert.equal(mayLinkSupportOrder(otherDriver,order,true),false);
 }
});

test('RC155: rate limit and payload guard fail closed without touching finances',()=>{
 assert.equal(DRIVER_SUPPORT_MAX_IN_WINDOW,8);
 for(const n of [-999,-1,8,9,1000,NaN,Infinity,2.5]){
  assert.equal(driverSupportQuotaExceeded(n),true);
 }
 assert.equal(driverSupportQuotaExceeded(7),false);
 for(const bad of ['  Necesito ayuda con esta entrega',''.padEnd(1201,'x'),'',null]){
  assert.equal(validDriverSupportPayload('delivery_issue',bad),false);
 }
 assert.equal(validDriverSupportPayload('safety_issue','Necesito asistencia en esta entrega'),true);
 const paths=new URL('../src/platform/routes.ts',import.meta.url);
 const routes=readFileSync(paths,'utf8');
 const start=routes.indexOf("platformRouter.post('/support'");
 const section=routes.slice(start,routes.indexOf('// E4:',start));
 assert.ok(start>=0);
 assert.match(section,/if\(account\.role==='driver'\)/);
 assert.match(section,/if\(config\.DRIVER_ORDER_SUPPORT_ENABLED!=='true'\)/);
 assert.match(section,/withUserLock\(account\.id,async tx=>/);
 assert.match(section,/SELECT id FROM orders WHERE id=\$1 FOR UPDATE/);
 assert.match(section,/mayLinkSupportOrder\(account,order,true\)/);
 assert.match(section,/driverSupportQuotaExceeded\(count\)/);
 assert.doesNotMatch(section,/stripe\.|driverComplete\(|driverStatus\(/);
});

test('RC155: zero write to order, GPS, stripe, wallet and delivery state in support route',()=>{
 const source=readFileSync(new URL('../src/platform/routes.ts',import.meta.url),'utf8');
 const start=source.indexOf("platformRouter.post('/support'");
 const body=source.slice(start,source.indexOf('// E4:',start));
 assert.doesNotMatch(body,/marketOrder\.(update|delete|create)/);
 assert.doesNotMatch(body,/marketplaceDriverProfile\.(update|create|delete)/);
 assert.doesNotMatch(body,/stageOrderEvent\.(create|update)/);
 assert.doesNotMatch(body,/stripe|payout|transfer|ledger|webhook/i);
 assert.match(body,/platformSupportTicket\.create/);
});
