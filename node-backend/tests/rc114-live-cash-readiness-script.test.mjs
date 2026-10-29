import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const path=new URL('../scripts/rc114-kali-live-cash-readiness.mjs',import.meta.url);
const src=readFileSync(path,'utf8');
test('RC114 read-only LIVE payment capacity audit is parseable, Git SHA pinned and fails closed',()=>{
 const parsed=spawnSync(process.execPath,['--check',path.pathname],{encoding:'utf8'});
 assert.equal(parsed.status,0,parsed.stderr);
 for(const key of [
  "RC114_ABORT=PINNED_SHA_REQUIRED","RC114_ABORT=PRODUCTION_IDENTITY",
  "RC114_ABORT=LIVE_DRIVER_OR_PRICING_POLICY",
  "RC114_ABORT=DELIVERY_ALREADY_RELEASED",
  "RC114_ABORT=STRIPE_OR_PAYOUT_RELEASE_CHANGED",
  "RC114_ABORT=WORKER_HEARTBEAT_OFFLINE",
  "RC114_LIVE_DATABASE_IDENTITY=PASS","RC114_LIVE_WORKER_HEARTBEAT=PASS",
  "RC114_SELLERS_WITH_REACHABLE_IDLE_DRIVER_SAMPLE=",
  "RC114_CASH_RELEASE_READINESS=HOLD_NO_APPROVED_STRIPE_SELLER_AND_DRIVER_PAIR",
  "RC114_E2E_ORDER_PAYMENT_PIN=NOT_VERIFIED",
  "RC114_OWNER_APPROVED_CONNECT_MAPPINGS_SAMPLE=",
  "RC114_STRIPE_LIVE_SELLERS_ELIGIBLE_SAMPLE=",
  "RC114_DB_WRITES=NONE","RC114_REDIS_WRITES=NONE",
  "tala_node_live","15445","hasReachableLiveDriver","assertRestaurantDeliveryOrigin",
 ])assert.ok(src.includes(key),key);
 for(const action of [
  "paymentIntents.create","stripe.transfers.create","prisma migrate deploy",
  "db.marketOrder.create(","db.marketplaceRestaurant.update(",
  "redis.set(","redis.del(","pg_dump","ALTER TABLE","UPDATE orders",
 ])assert.ok(!src.includes(action),action);
});
test('RC114 cannot run without exact SHA and service identity',()=>{
 for(const args of [[],['bad'],['0'.repeat(40)]]){
  const processRun=spawnSync(process.execPath,[path.pathname,...args],{
   encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:'/tmp',USER:'nobody'}
  });
  assert.notEqual(processRun.status,0,args.join(' '));
 }
});
