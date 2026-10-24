import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectLiveFinancialData} from '../dist/live/financial-readiness.js';

// Parse enough PostgreSQL lexical rules to ensure that each SQL grouping is
// balanced independently of client code, including quoted SQL literals.
function balancedSqlParentheses(sql){
 let depth=0,quote=null,lineComment=false;
 for(let i=0;i<sql.length;i++){
  const ch=sql[i],next=sql[i+1];
  if(lineComment){if(ch==='\n')lineComment=false;continue;}
  if(quote){
   if(ch===quote){
    if(next===quote){i++;continue;}
    quote=null;
   }
   continue;
  }
  if(ch==='-'&&next==='-'){lineComment=true;i++;continue;}
  if(ch==="'"||ch==='"'){quote=ch;continue;}
  if(ch==='(')depth++;
  if(ch===')')depth--;
  if(depth<0)return false;
 }
 return depth===0&&quote===null;
}

test('LIVE financial SELECT groups remain balanced after receipt/refund additions',async()=>{
 let captured='';
 const pool={query:async sql=>{
  captured=sql;
  return {rows:[{
    pending_payment_receipts:'0',
    pending_refund_or_dispute_events:'0',
    suspect_captured_orders:'0',
    stuck_provider_reservations:'0',
  }]};
 }};
 const result=await inspectLiveFinancialData(pool);
 assert.equal(result.classification,'LIVE_FINANCIAL_DATA_PASS');
 assert.equal(balancedSqlParentheses(captured),true,
  'Financial readiness SQL must have balanced PostgreSQL grouping');
 assert.match(captured,/e\."objectId"/);
 assert.match(captured,/AS pending_refund_or_dispute_events/);
});
test('financial readiness remains blocked if even one webhook is unresolved',async()=>{
 const pool={query:async()=>({rows:[{
  pending_payment_receipts:'0',
  pending_refund_or_dispute_events:'1',
  suspect_captured_orders:'0',
  stuck_provider_reservations:'0',
 }]})};
 const result=await inspectLiveFinancialData(pool);
 assert.equal(result.classification,'LIVE_FINANCIAL_DATA_HOLD');
});
