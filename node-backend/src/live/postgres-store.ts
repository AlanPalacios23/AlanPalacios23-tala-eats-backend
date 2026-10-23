/**
 * Live checkout storage for a distinct, migrated PRODUCTION database.
 * Construction alone does not connect or mutate; NEVER point at RC7 PG15.
 * This adapter is not referenced by staging app.ts or worker.ts.
 */
import { Pool } from 'pg';
import { LiveGateError,type ValidatedLiveSettings } from './guard.js';
import { LIVE_PI_RESERVED,type LivePaymentStore,type LivePendingOrder } from './stripe-payments.js';

export function productionPool(settings:ValidatedLiveSettings):Pool {
  return new Pool({
    connectionString:settings.databaseUrl,max:5,
    connectionTimeoutMillis:5000,idleTimeoutMillis:15000,
    application_name:'tala-rc8-live-payment',
  });
}
type Row={
  id:number;user_id:number;status:string;payment_status:string;
  payment_method:string;payment_provider:string;payment_provider_id:string;
  order_type:string;total:string;created_at:Date;refunded_amount:string;
};
export class PostgresLivePaymentStore implements LivePaymentStore {
  constructor(private readonly pool:Pool) {}
  async reserveForPayment(orderId:number,buyerId:number):Promise<LivePendingOrder|null>{
    const client=await this.pool.connect();
    try{
      await client.query('BEGIN');
      // Locks serialize concurrent customer requests. The reservation is
      // committed BEFORE any external Stripe API call, never inside its RPC.
      const found=await client.query<Row>(`
        SELECT id,user_id,status,payment_status,payment_method,
               payment_provider,payment_provider_id,order_type,
               total::text,created_at,refunded_amount::text
        FROM orders WHERE id=$1 AND user_id=$2 FOR UPDATE
      `,[orderId,buyerId]);
      const row=found.rows[0];
      if(!row){await client.query('ROLLBACK');return null;}
      if(row.status!=='awaiting_payment'||row.payment_status!=='pending'||
         row.payment_method!=='stripe'||row.payment_provider!=='stripe'||
         row.order_type!=='pickup'||Number(row.refunded_amount)!==0){
        await client.query('ROLLBACK');
        throw new LiveGateError('ORDER_STATE_NOT_ELIGIBLE');
      }
      let pointer=row.payment_provider_id;
      if(!pointer){
        const update=await client.query(`
          UPDATE orders SET payment_provider_id=$1 WHERE id=$2
          AND user_id=$3 AND payment_provider_id=''
        `,[LIVE_PI_RESERVED,orderId,buyerId]);
        if(update.rowCount!==1)throw new LiveGateError('RESERVATION_UPDATE_FAILED');
        pointer=LIVE_PI_RESERVED;
      }
      const decimal=/^(?:0|[1-9]\d{0,7})\.\d{2}$/;
      if(!decimal.test(row.total))throw new LiveGateError('ORDER_TOTAL_INVALID');
      const [major,fraction]=row.total.split('.');
      const minor=Number(major)*100+Number(fraction);
      const createdAtMs=new Date(row.created_at).getTime();
      if(!Number.isFinite(createdAtMs))throw new LiveGateError('ORDER_TIMESTAMP_INVALID');
      await client.query('COMMIT');
      return {id:row.id,buyerId:row.user_id,amountMinor:minor,
        currency:'mxn',method:'stripe',fulfillment:'pickup',
        status:'awaiting_payment',paymentStatus:'pending',
        intentId:pointer,createdAtMs,refundedMinor:0};
    }catch(error){
      await client.query('ROLLBACK').catch(()=>{});
      throw error;
    }finally{client.release();}
  }
  async attachStripeIntent(orderId:number,buyerId:number,intentId:string):Promise<boolean>{
    if(!/^pi_[A-Za-z0-9]+$/.test(intentId))
      throw new LiveGateError('INVALID_STRIPE_INTENT_ID');
    const done=await this.pool.query(`
      UPDATE orders SET payment_provider_id=$1
      WHERE id=$2 AND user_id=$3 AND payment_provider_id=$4
      AND status='awaiting_payment' AND payment_status='pending'
      RETURNING id
    `,[intentId,orderId,buyerId,LIVE_PI_RESERVED]);
    return done.rowCount===1;
  }
}
