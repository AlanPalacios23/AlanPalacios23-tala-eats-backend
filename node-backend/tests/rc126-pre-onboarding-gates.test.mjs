import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {canUseCommercialOnboardingRole} from '../dist/operational/onboarding-role-policy.js';
import {pickupCapability,deliveryCapability} from '../dist/live/pickup-readiness.js';
import {treasuryBalance} from '../dist/live/treasury-policy.js';

test('RC12.6 new identities can apply for a merchant or driver role',()=>{
 for(const target of ['restaurant','driver']){
  assert.equal(canUseCommercialOnboardingRole('customer',target),true);
  assert.equal(canUseCommercialOnboardingRole(target,target),true);
 }
});

test('RC12.6 cannot cross-enroll or promote privileged identities',()=>{
 for(const [role,target] of [['driver','restaurant'],['restaurant','driver'],
  ['admin','restaurant'],['admin','driver'],['support','driver'],
  ['customer','admin'],['customer','other']]){
  assert.equal(canUseCommercialOnboardingRole(role,target),false,role+' -> '+target);
 }
 const routes=readFileSync(new URL('../src/operational/routes.ts',import.meta.url),'utf8');
 assert.match(routes,/canUseCommercialOnboardingRole\(who\.role,p\.entity_type\)/);
 assert.match(routes,/canUseCommercialOnboardingRole\(account\.role,old\.entityType\)/);
});

const merchant={id:17,is_open:true,pickup_enabled:true,
 verification_status:'verified',onboarding_status:'approved',
 owner_id:91,owner_email:'merchant@example.test',owner_active:true,
 stripe_account_id:'acct_MERCHANT17',owner_approved_at:new Date()};
const seller={id:'acct_MERCHANT17',country:'MX',email:'merchant@example.test',
 details_submitted:true,payouts_enabled:true,capabilities:{transfers:'active'}};

test('RC12.6 platform with zero existing sellers is normal before onboarding',()=>{
 const pickup=pickupCapability(null,null,true,'acct_PLATFORM',false);
 const delivery=deliveryCapability(null,null,true,'acct_PLATFORM',false,false,false);
 assert.equal(pickup.ready,false);
 assert.equal(delivery.ready,false);
 assert.equal(pickup.reason,'RESTAURANT_NOT_FOUND');
 assert.equal(delivery.reason,'RESTAURANT_NOT_FOUND');
});

test('RC12.6 newly onboarded seller is assessed independently for pickup and delivery',()=>{
 const pickup=pickupCapability(merchant,seller,true,'acct_PLATFORM',false);
 assert.equal(pickup.ready,true);
 assert.equal(pickup.stripe_enabled,true);
 assert.equal(pickup.cash_enabled,false);
 const unavailable=deliveryCapability(merchant,seller,true,'acct_PLATFORM',true,false,false);
 assert.equal(unavailable.reason,'DRIVER_CAPACITY_UNAVAILABLE');
 assert.equal(unavailable.ready,false);
 const ready=deliveryCapability(merchant,seller,true,'acct_PLATFORM',true,false,true);
 assert.equal(ready.ready,true);
 assert.equal(ready.cash_enabled,true);
 assert.equal(ready.stripe_enabled,false);
 assert.equal(deliveryCapability(merchant,seller,true,'acct_PLATFORM',false,false,true).reason,
  'LIVE_DELIVERY_NOT_RELEASED');
});

test('RC12.6 Connect bank balance alone never produces withdrawable funds',()=>{
 const wallet=treasuryBalance({
  amountTransferredMinor:0n,committedWithdrawalsMinor:0n,
  stripeAvailableMinor:100000n,openFinancialCases:0,pendingTransferCount:0,
  unrecognizedProviderPayouts:0,bankVerified:true,scheduleManual:true,
  ownerApproved:true,connectReady:true,pendingUnknownWithdrawals:0
 });
 assert.equal(wallet.withdrawableMinor,0n);
 assert.equal(wallet.eligible,false);
 assert.equal(wallet.source,'verified_connect_transfers_only');
});
