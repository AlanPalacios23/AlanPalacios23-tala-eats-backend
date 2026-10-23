/**
 * Isolated live-checkout adapter. This is library code: RC7 never mounts it.
 * Requires an authenticated production session and dedicated PostgreSQL.
 */
import {Router} from 'express';
import type {Pool} from 'pg';
import type {Redis} from 'ioredis';
import {createHash} from 'node:crypto';
import {verifyToken} from '../auth/crypto.js';
import type {ValidatedLiveSettings} from './guard.js';
import {LiveGateError} from './guard.js';
import {PostgresLivePaymentStore} from './postgres-store.js';
import {createLivePickupPaymentIntent,type LiveStripeApi} from './stripe-payments.js';
import {inspectLiveFinancialData} from './financial-readiness.js';

type Gate={
  enabled:boolean;
  authSecret:string;
  pool:Pool;
  redis:Pick<Redis,'eval'>;
  stripe:LiveStripeApi;
  settings:ValidatedLiveSettings;
};
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
export function buildIsolatedCheckoutRouter(g:Gate){
 if(g.authSecret.length<48)throw new LiveGateError('PROD_SESSION_SECRET_REQUIRED');
 const router=Router();
 const store=new PostgresLivePaymentStore(g.pool);
 router.post('/orders/:id/stripe/payment-intent',async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(!g.enabled){res.status(503).json({error:'LIVE_PILOT_NOT_APPROVED'});return;}
  const id=req.params.id;
  const orderId=typeof id==='string'&&/^[1-9][0-9]{0,9}$/.test(id)
     ? Number(id):NaN;
  if(!Number.isSafeInteger(orderId)){res.status(422).json({error:'ORDER_ID_INVALID'});return;}
  const authorization=req.get('authorization')??'';
  if(!authorization.startsWith('Bearer ')||authorization.length>4200){
    res.status(401).json({error:'AUTH_REQUIRED'});return;
  }
  const token=authorization.slice(7);
  const claims=verifyToken(token,g.authSecret);
  if(!claims||claims.role!=='customer'||!claims.jti){
    res.status(401).json({error:'CUSTOMER_IDENTITY_INVALID'});return;
  }
  try{
    const buyer=Number(claims.sub);
    const verified=await g.pool.query<{id:number;role:string;active:boolean;is_active:boolean}>(`
      SELECT u.id,u.role,s.active,u.is_active
      FROM device_sessions s
      JOIN users u ON u.id=s.user_id
      WHERE s.session_hash=$1 AND s.user_id=$2 AND u.role='customer'
      LIMIT 1
    `,[sha(token),buyer]);
    const user=verified.rows[0];
    if(!user||!user.active||!user.is_active||user.role!=='customer'){
      res.status(401).json({error:'SESSION_REVOKED'});return;
    }
    // A release flag is not permission to charge a card when a prior
    // refund/dispute, captured-but-unposted order or orphaned PI exists.
    // Read-only query on the SAME independent PostgreSQL connection that
    // will hold the order's immutable financial ledger. Fail closed on error.
    const audit=await inspectLiveFinancialData(g.pool);
    if(audit.classification!=='LIVE_FINANCIAL_DATA_PASS'){
      res.status(503).json({error:'LIVE_FINANCIAL_RECONCILIATION_HOLD'});
      return;
    }
    const key='rc8:live:checkout:buyer:'+sha(String(buyer));
    const n=await g.redis.eval(
      "local c=redis.call('INCR',KEYS[1]);if c==1 then redis.call('EXPIRE',KEYS[1],60) end;return c",
      1,key);
    if(typeof n!=='number'){res.status(503).json({error:'RATE_LIMIT_DOWN'});return;}
    if(n>5){res.status(429).json({error:'RATE_LIMIT'});return;}
    const intent=await createLivePickupPaymentIntent(
      store,g.stripe,g.settings,orderId,buyer);
    res.status(200).json(intent);
  }catch(error){
    if(error instanceof LiveGateError){
      res.status(409).json({error:error.reason});return;
    }
    res.status(503).json({error:'PAYMENT_RECONCILIATION_REQUIRED'});
  }
 });
 return router;
}
