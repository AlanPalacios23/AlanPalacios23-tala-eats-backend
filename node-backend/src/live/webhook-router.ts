/**
 * Isolated production webhook router, mounted BEFORE express.json().
 * Durable inbox success is a prerequisite for HTTP 200.
 */
import {Router,raw} from 'express';
import type Stripe from 'stripe';
import type {Pool} from 'pg';
import {LiveGateError,type ValidatedLiveSettings} from './guard.js';
import {ingestSignedLiveStripeWebhook} from './webhook-inbox.js';

export function buildIsolatedWebhookRouter(
 stripe:Pick<Stripe,'webhooks'>,pool:Pool,settings:ValidatedLiveSettings,
 endpointPath:'/stripe'|'/webhook'='/stripe'){
 const router=Router();
 router.post(endpointPath,raw({type:'application/json',limit:'256kb'}),
 async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const signature=req.get('stripe-signature');
  if(!signature||signature.length>4096||!Buffer.isBuffer(req.body)){
   res.status(400).json({error:'WEBHOOK_SIGNATURE_OR_BODY_MISSING'});return;
  }
  try{
   const result=await ingestSignedLiveStripeWebhook(
    req.body,signature,stripe,pool,settings);
   res.status(200).json(result);
  }catch(err){
   if(err instanceof LiveGateError){
     res.status(400).json({error:err.reason});return;
   }
   if(err instanceof Error &&
      (err.name==='StripeSignatureVerificationError'||
       err.name==='StripeInvalidRequestError')){
     res.status(400).json({error:'WEBHOOK_VERIFICATION_FAILED'});return;
   }
   // Stripe can retry a 503; no ACK until PG commits the receipt.
   res.status(503).json({error:'WEBHOOK_DURABLE_STORAGE_UNAVAILABLE'});
  }
 });
 return router;
}
