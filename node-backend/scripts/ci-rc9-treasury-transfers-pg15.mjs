/** RC9: full order -> dual-admin Stripe Connect transfers on disposable PG15.
 * Stripe SDK methods are local mocks: no real card charges or money movement.
 */
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {recordTreasuryTransferReview} from '../dist/live/treasury-transfer-reservations.js';
import {dispatchTreasuryTransfer} from '../dist/live/treasury-dispatch.js';
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const payee=async(label,role)=>{
 const e=label+randomUUID().slice(0,9)+'@example.test';
 const r=await pool.query('INSERT INTO users(name,email,role,two_factor_enabled) VALUES($1,$2,$3,$4) RETURNING id,email',
  [label,e,role,role!=='customer']);
 return r.rows[0];
};
try{
 const seller=await payee('qa-seller','restaurant');
 const driver=await payee('qa-driver','driver');
 const adminA=await payee('qa-review','admin');
 const adminB=await payee('qa-approve','admin');
 const customer=await payee('qa-customer','customer');
 const rid=(await pool.query("INSERT INTO restaurants(name,owner_id) VALUES('RC9 transfer test',$1) RETURNING id",[seller.id])).rows[0].id;
 await pool.query("INSERT INTO driver_profiles(user_id,is_verified) VALUES($1,true)",[driver.id]);
 const sellerAcct='acct_QA'+randomUUID().replaceAll('-','').slice(0,10);
 const driverAcct='acct_QA'+randomUUID().replaceAll('-','').slice(0,10);
 await pool.query("INSERT INTO tala_live_merchant_accounts(restaurant_id,stripe_account_id,registered_by_user_id,owner_approved_at) VALUES($1,$2,$3,NOW())",[rid,sellerAcct,adminA.id]);
 await pool.query("INSERT INTO tala_live_driver_accounts(user_id,stripe_account_id,registered_by_user_id,owner_approved_at) VALUES($1,$2,$3,NOW())",[driver.id,driverAcct,adminA.id]);
 const pi='pi_QA'+randomUUID().replaceAll('-','').slice(0,9);
 const charge='ch_QA'+randomUUID().replaceAll('-','').slice(0,9);
 const oid=(await pool.query(
  "INSERT INTO orders(user_id,restaurant_id,driver_id,address,status,payment_method,payment_status,total,delivered_at,payment_provider_id,order_type) VALUES($1,$2,$3,'QA','delivered','stripe','paid',100.00,NOW(),$4,'delivery') RETURNING id",
  [customer.id,rid,driver.id,pi])).rows[0].id;
 await pool.query("INSERT INTO delivery_proofs(order_id,driver_id,pin_verified) VALUES($1,$2,true)",[oid,driver.id]);
 await pool.query("INSERT INTO financial_ledger_entries(order_id,account,direction,amount,kind,idempotency_key) VALUES($1,'stripe_live_collected','credit',100.00,'stripe_live_payment',$2)",[oid,'order:'+oid+':stripe-live:collected']);
 await pool.query("INSERT INTO tala_live_payee_allocations(order_id,payee_kind,payee_id,amount_minor,tender,fulfillment,state) VALUES($1,'restaurant',$2,6500,'stripe','platform_delivery','held')",[oid,rid]);
 await pool.query("INSERT INTO tala_live_payee_allocations(order_id,payee_kind,payee_id,amount_minor,tender,fulfillment,state) VALUES($1,'driver',$2,2500,'stripe','platform_delivery','held')",[oid,driver.id]);
 let created=0;
 const provider={
  paymentIntents:{retrieve:async(id)=>{assert.equal(id,pi);return {
   livemode:false,status:'succeeded',currency:'mxn',metadata:{order_id:String(oid)},
   amount_received:10000,latest_charge:charge};}},
  charges:{retrieve:async(id)=>{assert.equal(id,charge);return {
   id:charge,livemode:false,paid:true,captured:true,refunded:false,
   disputed:false,amount_refunded:0,currency:'mxn',amount_captured:10000};}},
  accounts:{retrieve:async(account)=>({
   id:account,country:'MX',email:account===sellerAcct?seller.email:driver.email,
   payouts_enabled:true,details_submitted:true,capabilities:{transfers:'active'},
   requirements:{currently_due:[],past_due:[],disabled_reason:null}
  })},
  transfers:{create:async(args,opts)=>{
   created++;
   assert.equal(args.source_transaction,charge);
   assert.equal(args.currency,'mxn');
   assert.ok([sellerAcct,driverAcct].includes(args.destination));
   assert.ok(opts.idempotencyKey.startsWith('tala-rc85:'));
   return {id:'tr_QA'+created,livemode:false,currency:'mxn',
    amount:args.amount,destination:args.destination,
    source_transaction:charge};
  }}
 };
 for(const [kind,id,account,amount] of [['restaurant',rid,sellerAcct,6500],['driver',driver.id,driverAcct,2500]]){
  const action={orderId:oid,kind,payeeId:id,adminId:adminA.id,adminMfaVerified:true,phase:'review'};
  await assert.rejects(recordTreasuryTransferReview(pool,provider,{...action,adminMfaVerified:false}),/MFA_REQUIRED/);
  const reviewed=await recordTreasuryTransferReview(pool,provider,action);
  assert.equal(reviewed.state,'manual_hold');
  await assert.rejects(recordTreasuryTransferReview(pool,provider,{...action,phase:'approve'}),/DUAL_CONTROL/);
  const approved=await recordTreasuryTransferReview(pool,provider,
    {...action,phase:'approve',adminId:adminB.id});
  assert.equal(approved.state,'reserved');
  const input={orderId:oid,kind,payeeId:id,amountMinor:amount,
   stripeAccountId:account,approvedByOwner:true,connectReady:true,
   chargeId:charge,capturedAmountMinor:10000,alreadyTransferred:false,
   delivered:true,proof:true,refundedMinor:0,openCases:0,sourceMode:'stripe'};
  const result=await dispatchTreasuryTransfer(pool,provider,approved.reservationId,input,true);
  assert.equal(result.state,'completed');
  await assert.rejects(dispatchTreasuryTransfer(pool,provider,approved.reservationId,input,true),
   /ALREADY_DISPATCHED_OR_UNKNOWN|RESERVATION_CHANGED/);
 }
 assert.equal(created,2);
 const db=await pool.query('SELECT state,stripe_transfer_id FROM tala_live_treasury_transfers WHERE order_id=$1',[oid]);
 assert.equal(db.rows.length,2);
 assert.ok(db.rows.every(x=>x.state==='completed'&&x.stripe_transfer_id?.startsWith('tr_')));
 console.log('TREASURY_RESTAURANT_DRIVER_DUAL_ADMIN_TRANSFER_PG15_PASS');
 console.log('SYNTHETIC_STRIPE_TRANSFERS=2 REAL_TRANSFERS=0');
}finally{await pool.end();}
