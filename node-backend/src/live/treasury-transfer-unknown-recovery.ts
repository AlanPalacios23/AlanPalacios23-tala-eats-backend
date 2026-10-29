/** Recover an ambiguous Connect TRANSFER after Stripe response loss.
 * NEVER re-create a transfer, reuse a new idempotency key, or invent money.
 * Search only the original order's transfer_group and verify complete pages.
 * A single uniquely identified TEST/LIVE transfer can be attached by CAS.
 * No background worker calls this until separately audited and authorized.
 */
import type Stripe from 'stripe';
import type {Pool} from 'pg';

type Stored={
 id:string;state:string;order_id:number;payee_kind:'restaurant'|'driver';
 payee_id:number;connected_account_id:string;source_charge_id:string;
 amount_minor:string;idempotency_key:string;stripe_transfer_id:string|null;
 reviewed_by_user_id:number|null;approved_by_user_id:number|null;
};
type Reads=Pick<Stripe,'transfers'|'charges'>;
const idPattern=/^[1-9][0-9]{0,15}$/;
export type TransferRecovery='unknown'|'completed'|'already_resolved';
export async function recoverUnknownTreasuryTransfer(
 pool:Pick<Pool,'query'>,provider:Reads,id:string
):Promise<TransferRecovery>{
 if(!idPattern.test(id))throw Error('TREASURY_UNKNOWN_TRANSFER_ID_INVALID');
 const found=await pool.query<Stored>(
  'SELECT id::text,state,order_id,payee_kind,payee_id,connected_account_id,source_charge_id,amount_minor::text,idempotency_key,stripe_transfer_id,reviewed_by_user_id,approved_by_user_id FROM tala_live_treasury_transfers WHERE id=$1',
  [id]);
 const x=found.rows[0];
 if(!x)throw Error('TREASURY_UNKNOWN_TRANSFER_NOT_FOUND');
 if(x.state!=='unknown'||x.stripe_transfer_id!==null)return 'already_resolved';
 const expectedKey='tala-rc85:'+x.order_id+':'+x.payee_kind+':'+x.payee_id;
 if(!Number.isSafeInteger(x.order_id)||x.order_id<1||
  !Number.isSafeInteger(x.payee_id)||x.payee_id<1||
  !['restaurant','driver'].includes(x.payee_kind)||
  !/^acct_[A-Za-z0-9]+$/.test(x.connected_account_id)||
  !/^ch_[A-Za-z0-9]+$/.test(x.source_charge_id)||
  !/^[1-9]\d{0,13}$/.test(x.amount_minor)||
  x.idempotency_key!==expectedKey||
  !Number.isSafeInteger(x.reviewed_by_user_id)||
  !Number.isSafeInteger(x.approved_by_user_id)||
  x.reviewed_by_user_id===x.approved_by_user_id)
  throw Error('TREASURY_UNKNOWN_TRANSFER_IDENTITY_HOLD');
 const amount=Number(x.amount_minor);
 if(!Number.isSafeInteger(amount)||amount<1)
  throw Error('TREASURY_UNKNOWN_TRANSFER_AMOUNT_HOLD');
 const expectedLive=process.env.NODE_ENV==='production';
 if(process.env.NODE_ENV!=='production'&&process.env.NODE_ENV!=='staging')
  throw Error('TREASURY_UNKNOWN_TRANSFER_ENV_INVALID');
 let cursor:string|undefined,complete=false,match:Stripe.Transfer|null=null;
 const group='TALA-ORDER-'+x.order_id;
 const seen=new Set<string>();
 for(let page=0;page<10;page++){
  const transfers=await provider.transfers.list({
   transfer_group:group,limit:100,
   ...(cursor?{starting_after:cursor}:{})
  });
  if(!Array.isArray(transfers.data)||transfers.data.length>100)
   throw Error('TREASURY_UNKNOWN_TRANSFER_LIST_INVALID');
  for(const t of transfers.data){
   if(!/^tr_[A-Za-z0-9]+$/.test(t.id)||seen.has(t.id))
    throw Error('TREASURY_UNKNOWN_TRANSFER_DUPLICATE_PAGE');
   seen.add(t.id);
   if(t.metadata?.tala_treasury_reservation!==id)continue;
   if(match)throw Error('TREASURY_UNKNOWN_MULTIPLE_TRANSFERS');
   if(t.transfer_group!==group||t.livemode!==expectedLive||
    t.destination!==x.connected_account_id||
    t.source_transaction!==x.source_charge_id||
    t.amount!==amount||t.currency!=='mxn'||t.reversed===true||
    t.amount_reversed!==0||
    t.metadata?.tala_order_id!==String(x.order_id)||
    t.metadata?.tala_payee_kind!==x.payee_kind||
    t.metadata?.tala_payee_id!==String(x.payee_id))
    throw Error('TREASURY_UNKNOWN_TRANSFER_REMOTE_MISMATCH');
   match=t;
  }
  if(!transfers.has_more){complete=true;break;}
  const last=transfers.data.at(-1)?.id;
  if(!last||last===cursor)
   throw Error('TREASURY_UNKNOWN_TRANSFER_CURSOR_STALLED');
  cursor=last;
 }
 if(!complete)throw Error('TREASURY_UNKNOWN_TRANSFER_HISTORY_INCOMPLETE');
 if(!match)return 'unknown';
 const ch=await provider.charges.retrieve(x.source_charge_id);
 if(ch.id!==x.source_charge_id||ch.livemode!==expectedLive||
    !ch.paid||!ch.captured||ch.refunded||ch.disputed||
    ch.amount_refunded!==0||ch.currency!=='mxn'||ch.amount_captured<amount)
  throw Error('TREASURY_UNKNOWN_TRANSFER_SOURCE_CHARGE_HOLD');
 const update=await pool.query(
  "UPDATE tala_live_treasury_transfers SET state='completed',stripe_transfer_id=$2,updated_at=NOW() WHERE id=$1 AND state='unknown' AND stripe_transfer_id IS NULL AND connected_account_id=$3 AND source_charge_id=$4 AND amount_minor=$5 AND idempotency_key=$6",
  [id,match.id,x.connected_account_id,x.source_charge_id,x.amount_minor,x.idempotency_key]);
 if(update.rowCount!==1)throw Error('TREASURY_UNKNOWN_TRANSFER_CAS_REVIEW_REQUIRED');
 return 'completed';
}
