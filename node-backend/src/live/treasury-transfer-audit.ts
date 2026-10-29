/** RC12.7: verify ALL completed Connect transfers for a payee, not just 100.
 * Read-only Stripe + PostgreSQL, bounded to avoid a Wallet request performing
 * unbounded provider calls. Re-check count/sum to fail closed on concurrent
 * financial changes; never treat a partial scan as withdrawable.
 */
import type Stripe from 'stripe';
import type {Pool} from 'pg';

const LIMIT=1000, PAGE=50;
type Payee='restaurant'|'driver';
type TransferRow={
 id:string;order_id:number;payee_kind:Payee;payee_id:number;
 connected_account_id:string;stripe_transfer_id:string;
 amount_minor:string;source_charge_id:string;
};
const amount=(s:string):bigint=>{
 if(!/^\d{1,16}$/.test(s))throw Error('TREASURY_TRANSFER_MINOR_INVALID');
 return BigInt(s);
};
const count=(s:string):number=>{
 if(!/^\d{1,10}$/.test(s))throw Error('TREASURY_TRANSFER_COUNT_INVALID');
 const n=Number(s);
 if(!Number.isSafeInteger(n)||n>LIMIT)
  throw Error('TREASURY_TRANSFER_AUDIT_LIMIT_EXCEEDED');
 return n;
};
export async function auditCompletedTreasuryTransfers(
 pool:Pick<Pool,'query'>,
 provider:Pick<Stripe,'transfers'|'charges'>,
 kind:Payee,payeeId:number,account:string,expectedLivemode=true,
):Promise<bigint>{
 if(!expectedLivemode&&process.env.NODE_ENV!=='staging')
  throw Error('TREASURY_TEST_AUDIT_REQUIRES_STAGING');
 if(!['restaurant','driver'].includes(kind)||!Number.isSafeInteger(payeeId)||
  payeeId<1||!/^acct_[A-Za-z0-9]+$/.test(account))
  throw Error('TREASURY_TRANSFER_IDENTITY_INVALID');
 const summarySql=`SELECT COUNT(*)::text AS n,
   COALESCE(SUM(amount_minor),0)::text AS amount_minor
   FROM tala_live_treasury_transfers
   WHERE payee_kind=$1 AND payee_id=$2 AND state='completed'`;
 const before=await pool.query<{n:string;amount_minor:string}>(summarySql,[kind,payeeId]);
 const expected=before.rows[0];
 if(!expected)throw Error('TREASURY_TRANSFER_SUMMARY_UNAVAILABLE');
 const n=count(expected.n),expectedTotal=amount(expected.amount_minor);
 let last=0n,total=0n,scanned=0;
 for(let p=0;p<Math.ceil(n/PAGE);p++){
  const data=await pool.query<TransferRow>(
   `SELECT id::text,order_id,payee_kind,payee_id,connected_account_id,
     stripe_transfer_id,amount_minor::text,source_charge_id
     FROM tala_live_treasury_transfers
     WHERE payee_kind=$1 AND payee_id=$2 AND state='completed' AND id>$3
     ORDER BY id ASC LIMIT 50`,[kind,payeeId,last.toString()]);
  if(data.rows.length===0||data.rows.length>PAGE)
   throw Error('TREASURY_TRANSFER_PAGINATION_INCONSISTENT');
  for(const row of data.rows){
   if(!/^[1-9]\d{0,18}$/.test(row.id)||BigInt(row.id)<=last||
      row.payee_kind!==kind||row.payee_id!==payeeId||
      row.connected_account_id!==account||
      !/^tr_[A-Za-z0-9]+$/.test(row.stripe_transfer_id)||
      !/^ch_[A-Za-z0-9]+$/.test(row.source_charge_id))
    throw Error('FOREIGN_STRIPE_TRANSFER');
   last=BigInt(row.id);
   const cents=amount(row.amount_minor);
   if(cents<=0n||cents>BigInt(Number.MAX_SAFE_INTEGER))
    throw Error('TREASURY_TRANSFER_MINOR_UNSAFE');
   const t=await provider.transfers.retrieve(row.stripe_transfer_id);
   if(t.id!==row.stripe_transfer_id||t.destination!==account||
      t.source_transaction!==row.source_charge_id||
      t.currency!=='mxn'||t.livemode!==expectedLivemode||
      t.amount!==Number(cents)||t.amount_reversed!==0)
    throw Error('PROVIDER_TRANSFER_INCONSISTENT');
   const charge=await provider.charges.retrieve(row.source_charge_id);
   if(charge.livemode!==expectedLivemode||charge.id!==row.source_charge_id||!charge.paid||
      charge.refunded||charge.disputed||charge.currency!=='mxn')
    throw Error('ORIGINAL_CHARGE_REFUND_DISPUTE_HOLD');
   total+=cents;scanned++;
  }
 }
 if(scanned!==n||total!==expectedTotal)
  throw Error('TREASURY_TRANSFER_PAGINATION_INCONSISTENT');
 const after=await pool.query<{n:string;amount_minor:string}>(summarySql,[kind,payeeId]);
 if(!after.rows[0]||count(after.rows[0].n)!==n||
    amount(after.rows[0].amount_minor)!==expectedTotal)
  throw Error('TREASURY_TRANSFER_CHANGED_DURING_AUDIT');
 return total;
}
