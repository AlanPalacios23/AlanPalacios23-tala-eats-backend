import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {auditCompletedTreasuryTransfers} from '../dist/live/treasury-transfer-audit.js';

const account='acct_RC127STORE';
const rows=Array.from({length:107},(_,i)=>({
 id:String(i+1),order_id:i+1,payee_kind:'restaurant',payee_id:42,
 connected_account_id:account,stripe_transfer_id:'tr_RC127_'+(i+1),
 amount_minor:'200',source_charge_id:'ch_RC127_'+(i+1),
}));

function fixture(data=rows,{mutateSummary=false,refund=false}={}){
 let summaries=0,reads=0,charges=0;
 const pool={query:async(sql,args)=>{
  if(sql.includes('COUNT(*)')){
   summaries++;
   return {rows:[{n:String(data.length+(mutateSummary&&summaries>1?1:0)),
    amount_minor:String(BigInt(data.length)*200n)}]};
  }
  const next=BigInt(args[2]);
  return {rows:data.filter(x=>BigInt(x.id)>next).slice(0,50)};
 }};
 const provider={
  transfers:{retrieve:async id=>{
   reads++;
   const row=data.find(v=>v.stripe_transfer_id===id);
   assert.ok(row);
   return {id,destination:row.connected_account_id,
    source_transaction:row.source_charge_id,currency:'mxn',livemode:true,
    amount:Number(row.amount_minor),amount_reversed:0};
  }},
  charges:{retrieve:async id=>{
   charges++;
   return {id,livemode:true,paid:true,refunded:refund,disputed:false,currency:'mxn'};
  }}
 };
 return {pool,provider,getStats:()=>({summaries,reads,charges})};
}

test('RC12.7 verifies 107 real-shaped completed transfers across three pages',async()=>{
 const f=fixture();
 const total=await auditCompletedTreasuryTransfers(f.pool,f.provider,'restaurant',42,account);
 assert.equal(total,21400n);
 assert.deepEqual(f.getStats(),{summaries:2,reads:107,charges:107});
 const source=readFileSync(new URL('../src/live/treasury-router.ts',import.meta.url),'utf8');
 assert.match(source,/auditCompletedTreasuryTransfers\(pool,stripe,x\.kind,x\.id,x\.account\)/);
 assert.doesNotMatch(source,/LIMIT 101/);
});

test('RC12.7 zero transfers returns zero without remote Stripe reads',async()=>{
 const f=fixture([]);
 assert.equal(await auditCompletedTreasuryTransfers(f.pool,f.provider,'driver',42,account),0n);
 assert.deepEqual(f.getStats(),{summaries:2,reads:0,charges:0});
});

test('RC12.7 1001 transfers fail closed before any external provider call',async()=>{
 const a=Array.from({length:1001},(_,i)=>({
 ...rows[0],id:String(i+1),stripe_transfer_id:'tr_RC127_'+(i+1)}));
 const f=fixture(a);
 await assert.rejects(
  auditCompletedTreasuryTransfers(f.pool,f.provider,'restaurant',42,account),
  /TREASURY_TRANSFER_AUDIT_LIMIT_EXCEEDED/);
 assert.equal(f.getStats().reads,0);
});

test('RC12.7 concurrent financial change invalidates entire wallet result',async()=>{
 const f=fixture(rows,{mutateSummary:true});
 await assert.rejects(
  auditCompletedTreasuryTransfers(f.pool,f.provider,'restaurant',42,account),
  /TREASURY_TRANSFER_CHANGED_DURING_AUDIT/);
});

test('RC12.7 refunded source charge or wrong Connect recipient stops withdrawal',async()=>{
 const f=fixture(rows,{refund:true});
 await assert.rejects(
  auditCompletedTreasuryTransfers(f.pool,f.provider,'restaurant',42,account),
  /ORIGINAL_CHARGE_REFUND_DISPUTE_HOLD/);
 const forged=rows.map(x=>({...x}));
 forged[50].connected_account_id='acct_FOREIGN';
 const other=fixture(forged);
 await assert.rejects(
  auditCompletedTreasuryTransfers(other.pool,other.provider,'restaurant',42,account),
  /FOREIGN_STRIPE_TRANSFER/);
});

test('RC12.7 pagination refuses duplicate transfer IDs and incomplete result pages',async()=>{
 const duplicate=rows.map(x=>({...x}));
 duplicate[50].id=duplicate[49].id;
 const f=fixture(duplicate);
 await assert.rejects(
  auditCompletedTreasuryTransfers(f.pool,f.provider,'restaurant',42,account),
  /TREASURY_TRANSFER_PAGINATION_INCONSISTENT/);
});
