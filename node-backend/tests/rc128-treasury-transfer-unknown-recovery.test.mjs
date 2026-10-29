import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {recoverUnknownTreasuryTransfer}
 from '../dist/live/treasury-transfer-unknown-recovery.js';
const row={id:'11',state:'unknown',order_id:123,payee_kind:'restaurant',
 payee_id:42,connected_account_id:'acct_RC128MERCHANT',
 source_charge_id:'ch_RC128CHARGE',amount_minor:'3200',
 idempotency_key:'tala-rc85:123:restaurant:42',
 stripe_transfer_id:null,reviewed_by_user_id:5,approved_by_user_id:9};
const t={id:'tr_RC128PROVED',livemode:false,transfer_group:'TALA-ORDER-123',
 destination:row.connected_account_id,source_transaction:row.source_charge_id,
 currency:'mxn',amount:3200,reversed:false,amount_reversed:0,
 metadata:{tala_treasury_reservation:'11',tala_order_id:'123',
  tala_payee_kind:'restaurant',tala_payee_id:'42'}};
function mock(transfers=[t]){
 let state={...row},writes=0,charges=0;
 const pool={query:async(sql,args)=>{
  if(sql.startsWith('SELECT'))return {rows:[state]};
  if(sql.startsWith('UPDATE')){
   writes++;
   assert.equal(args[0],'11');assert.equal(args[1],t.id);
   assert.equal(args[2],row.connected_account_id);
   state={...state,state:'completed',stripe_transfer_id:args[1]};
   return {rowCount:1};
  }
  throw Error('UNEXPECTED_QUERY');
 }};
 const provider={
  transfers:{list:async(args)=>{
   assert.equal(args.transfer_group,'TALA-ORDER-123');
   assert.equal(args.limit,100);
   return {data:transfers,has_more:false};
  }},
  charges:{retrieve:async id=>{
   charges++;
   assert.equal(id,row.source_charge_id);
   return {id,livemode:false,paid:true,captured:true,
    refunded:false,disputed:false,amount_refunded:0,
    currency:'mxn',amount_captured:10000};
  }}
 };
 return {pool,provider,stats:()=>({writes,charges})};
}
test('RC12.8 recover signed TEST transfer after provider response timeout by read-only lookup',async()=>{
 const x=mock();
 assert.equal(await recoverUnknownTreasuryTransfer(x.pool,x.provider,'11'),'completed');
 assert.equal(await recoverUnknownTreasuryTransfer(x.pool,x.provider,'11'),'already_resolved');
 assert.deepEqual(x.stats(),{writes:1,charges:1});
});
test('RC12.8 no matching TEST Stripe transfer means UNKNOWN with NO retry',async()=>{
 const x=mock([]);
 assert.equal(await recoverUnknownTreasuryTransfer(x.pool,x.provider,'11'),'unknown');
 assert.deepEqual(x.stats(),{writes:0,charges:0});
});
test('RC12.8 duplicated or foreign Stripe transfers remain HOLD',async()=>{
 for(const data of [[t,t],[{...t,livemode:true}],
  [{...t,amount:3201}],[{...t,amount_reversed:100,reversed:true}]]){
  const x=mock(data);
  await assert.rejects(recoverUnknownTreasuryTransfer(x.pool,x.provider,'11'),
   /DUPLICATE_PAGE|REMOTE_MISMATCH/);
  assert.deepEqual(x.stats(),{writes:0,charges:0});
 }
});
test('RC12.8 recovery source has zero Stripe money writes',()=>{
 const source=readFileSync(
  new URL('../src/live/treasury-transfer-unknown-recovery.ts',import.meta.url),'utf8');
 assert.match(source,/transfers\.list\(/);
 assert.doesNotMatch(source,/transfers\.create|payouts\.create/);
});
