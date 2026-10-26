import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pickupCapability} from '../dist/live/pickup-readiness.js';

const merchant={
 id:7,is_open:true,pickup_enabled:true,verification_status:'verified',
 onboarding_status:'approved',owner_id:2,owner_email:'test@example.com',
 owner_active:true,stripe_account_id:'acct_TEST',owner_approved_at:new Date(),
};
const account={id:'acct_TEST',country:'MX',email:'test@example.com',
 details_submitted:true,payouts_enabled:true,capabilities:{transfers:'active'}};

test('merchant readiness requires approval and valid settlement recipient',()=>{
 const live=pickupCapability(merchant,account,true,'acct_PLATFORM',true);
 assert.equal(live.ready,true);
 assert.equal(live.cash_enabled,true);
 assert.equal(live.stripe_enabled,true);
 const unmapped=pickupCapability({...merchant,owner_approved_at:null},null,true,'acct_PLATFORM',true);
 assert.equal(unmapped.ready,false);
 assert.equal(unmapped.cash_enabled,false);
 assert.equal(unmapped.stripe_enabled,false);
});
test('all sensitive seller failures prohibit both payment modes',()=>{
 for(const edit of [
  {country:'US'}, {email:'other@example.com'}, {payouts_enabled:false},
  {details_submitted:false}, {capabilities:{transfers:'inactive'}},
  {id:'acct_PLATFORM'},
 ]){
  const out=pickupCapability(merchant,{...account,...edit},true,'acct_PLATFORM',true);
  assert.equal(out.ready,false);
 }
 for(const edit of [
  {is_open:false},{pickup_enabled:false},{verification_status:'pending'},
  {onboarding_status:'pending'},{owner_active:false},
 ]){
  const out=pickupCapability({...merchant,...edit},account,true,'acct_PLATFORM',true);
  assert.equal(out.ready,false);
 }
 assert.equal(pickupCapability(merchant,account,false,'acct_PLATFORM',true).ready,false);
});
