import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
 buildMoneyPlan,cashStatusTransition,cashCollectorWhoMaySubmit
} from '../dist/live/payee-allocation.js';

const base={orderId:18,restaurantId:5,driverUserId:null,
 orderType:'pickup',merchantManagedDelivery:false,tender:'stripe',
 totalMinor:21400,restaurantPayableMinor:17000,driverBaseMinor:0,
 cashCollectedMinor:0,
 tipMinor:0,status:'delivered',paymentStatus:'paid',
 deliveryProven:true,captured:true,openCases:0};
test('Stripe pickup: $214 customer, $170 merchant, $44 platform; no driver beneficiary',()=>{
 const p=buildMoneyPlan(base);
 assert.equal(p.fulfillment,'pickup');
 assert.deepEqual(p.obligations,[{party:'restaurant',payeeId:5,amountMinor:17000}]);
 assert.equal(p.totalMinor,21400);
 assert.equal(p.grossPlatformMinor,4400);
 assert.equal(p.cash,null);
 assert.equal(p.transferCreated,false);
});
test('platform delivery: $253, restaurant $170, driver $32, platform gross $51',()=>{
 const p=buildMoneyPlan({...base,orderType:'delivery',driverUserId:9,
   totalMinor:25300,driverBaseMinor:3200});
 assert.equal(p.fulfillment,'platform_delivery');
 assert.deepEqual(p.obligations,[
   {party:'restaurant',payeeId:5,amountMinor:17000},
   {party:'driver',payeeId:9,amountMinor:3200},
 ]);
 assert.equal(p.grossPlatformMinor,5100);
 assert.equal(p.cash,null);
});
test('driver gratuity is fully allocated without changing platform earnings',()=>{
 const p=buildMoneyPlan({...base,orderType:'delivery',
   driverUserId:9,totalMinor:27300,driverBaseMinor:3200,tipMinor:2000});
 assert.equal(p.obligations[1].amountMinor,5200);
 assert.equal(p.grossPlatformMinor,5100);
});
test('cash pickup: seller custodian owes platform $44, but bank settlement not implied',()=>{
 const p=buildMoneyPlan({...base,tender:'cash',paymentStatus:'paid',cashCollectedMinor:21400,captured:false});
 assert.deepEqual(p.cash,{
   collectorKind:'restaurant',collectorId:5,
   collectedMinor:21400,retainedMinor:17000,duePlatformMinor:4400,
   state:'awaiting_evidence'
 });
});
test('platform delivery paid in cash: courier holds full $253, no driver wage retained',()=>{
 const p=buildMoneyPlan({...base,tender:'cash',paymentStatus:'paid',cashCollectedMinor:25300,
   captured:false,orderType:'delivery',driverUserId:9,
   totalMinor:25300,driverBaseMinor:3200});
 assert.deepEqual(p.cash,{
   collectorKind:'driver',collectorId:9,
   collectedMinor:25300,retainedMinor:0,duePlatformMinor:25300,
   state:'awaiting_evidence'});
 assert.equal(p.grossPlatformMinor,5100);
});
test('merchant-managed delivery: seller gets delivery fee, no platform driver',()=>{
 const p=buildMoneyPlan({...base,orderType:'delivery',
   merchantManagedDelivery:true,totalMinor:25300,restaurantPayableMinor:20900});
 assert.equal(p.fulfillment,'merchant_delivery');
 assert.equal(p.obligations.length,1);
 assert.equal(p.grossPlatformMinor,4400);
 assert.equal(p.cash,null);
});
test('reject unverified collection, invalid delivery, and unearned payables',()=>{
 const invalid=[
   {status:'preparing'}, {deliveryProven:false},
   {tender:'stripe',paymentStatus:'pending'},
   {captured:false},
   {openCases:1},{restaurantPayableMinor:22000},
   {driverUserId:44},
   {orderType:'delivery',driverUserId:null},
   {orderType:'delivery',driverUserId:9,driverBaseMinor:0},
   {orderType:'delivery',driverUserId:9,tipMinor:30000},
   {tender:'cash',paymentStatus:'refunded'},
   {tender:'cash',paymentStatus:'pending',cashCollectedMinor:21400,captured:false},
   {tender:'cash',paymentStatus:'paid',cashCollectedMinor:21399,captured:false},
   {tender:'cash',paymentStatus:'paid',cashCollectedMinor:21400,captured:true},
   {tender:'stripe',cashCollectedMinor:21400},
   {tender:'cash',cashCollectedMinor:Infinity},
   {tender:'cash',cashCollectedMinor:21400,openCases:1,captured:false},
   {totalMinor:-1}, {tipMinor:Infinity},
   {orderType:'courier_unknown'},
 ];
 for(const patch of invalid)assert.throws(()=>buildMoneyPlan({...base,...patch}),undefined,JSON.stringify(patch));
});
test('cash review never self-certifies and a report is not a bank receipt',()=>{
 assert.equal(cashStatusTransition('awaiting_evidence','submit'),'submitted');
 assert.equal(cashStatusTransition('submitted','review'),'reviewed');
 assert.equal(cashStatusTransition('reviewed','settle'),'settled');
 assert.throws(()=>cashStatusTransition('awaiting_evidence','settle'));
 assert.equal(cashCollectorWhoMaySubmit(9,'driver',9,null),true);
 assert.equal(cashCollectorWhoMaySubmit(11,'driver',9,null),false);
 assert.equal(cashCollectorWhoMaySubmit(7,'restaurant',5,7),true);
 assert.equal(cashCollectorWhoMaySubmit(5,'restaurant',5,7),false);
 const source=readFileSync(new URL('../src/live/payee-finance-router.ts',import.meta.url),'utf8');
 assert.match(source,/status='awaiting_evidence'/);
 assert.match(source,/submitted_by<>/);
 assert.match(source,/bank_deposit_confirmed:false/);
 assert.match(source,/NO \/cash\/settle/);
 assert.doesNotMatch(source,/\.transfers\.create\(|\.payouts\.create\(|\.paymentIntents\.create\(/);
});
test('finance schema enforces per order/payee allocations and conservation of cash',()=>{
 const s=readFileSync(new URL('../prisma/migrations/20261024_rc85_restaurant_driver_cash/migration.sql',import.meta.url),'utf8');
 assert.match(s,/UNIQUE\(order_id,payee_kind\)/);
 assert.match(s,/retained_minor\+due_platform_minor=collected_minor/);
 assert.match(s,/submitted_by<>reviewed_by/);
 assert.match(s,/settled_by<>reviewed_by/);
 assert.match(s,/stripe_account_id VARCHAR\(120\) NOT NULL UNIQUE/);
 assert.match(s,/driver_accounts/);
});

test('RC13.8 cash needs verified full physical receipt; pickup can use its own proof',()=>{
 const source=readFileSync(new URL('../src/live/payee-finance-router.ts',import.meta.url),'utf8');
 assert.match(source,/cash_collected::text/);
 assert.match(source,/cashCollectedMinor:centavos\(o\.cash_collected\)/);
 assert.match(source,/status='delivered'\)\:\:text AS pickup_proof/);
 assert.match(source,/o\.order_type==='pickup'\?check\.pickup_proof==='1':check\.proof==='1'/);
 assert.match(source,/l\.amount=\(SELECT total FROM orders WHERE id=\$1\)/);
 assert.match(source,/STRIPE_PROVIDER_INTENT_NOT_BOUND/);
});
