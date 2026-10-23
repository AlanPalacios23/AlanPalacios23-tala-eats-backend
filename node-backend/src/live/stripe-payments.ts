/**
 * RC8 isolated LIVE PaymentIntent primitives.
 * No exported code is invoked by the RC7 stage API/worker. An authenticated
 * production HTTP service + isolated durable store must be completed before
 * these functions can be exposed to end users.
 */
import type Stripe from 'stripe';
import {livePilotAmount,liveReceiptIdentity,LiveGateError,
  type ValidatedLiveSettings} from './guard.js';
export type LivePendingOrder={
  id:number;buyerId:number;amountMinor:number;
  currency:'mxn';method:'stripe';fulfillment:'pickup';
  status:'awaiting_payment';paymentStatus:'pending';
  intentId:string|null;
  createdAtMs:number;refundedMinor:number;
};
export interface LivePaymentStore{
  // Both methods must be PostgreSQL transactions with row locking. reserve
  // claims the same order before Stripe API and NEVER releases it on timeout.
  reserveForPayment(orderId:number,buyerId:number,maxOrderMinor:number):
    Promise<LivePendingOrder|null>;
  attachStripeIntent(orderId:number,buyerId:number,intentId:string):
    Promise<boolean>;
}
export type LiveStripeApi=Pick<Stripe,'paymentIntents'|'webhooks'|'events'>;
const reserved='pi_reserving_rc8_live';
export const LIVE_PI_RESERVED=reserved;
function assertOrder(order:LivePendingOrder|undefined|null,buyerId:number,settings:ValidatedLiveSettings){
  if(!order||order.buyerId!==buyerId)throw new LiveGateError('ORDER_NOT_FOUND');
  if(order.currency!=='mxn'||order.method!=='stripe'||
    order.fulfillment!=='pickup'||order.status!=='awaiting_payment'||
    order.paymentStatus!=='pending'||order.refundedMinor!==0||
    Date.now()-order.createdAtMs>30*60_000)
    throw new LiveGateError('ORDER_NOT_ELIGIBLE');
  livePilotAmount(order.amountMinor,settings.maxOrderMinor);
}
export async function createLivePickupPaymentIntent(
  store:LivePaymentStore,provider:LiveStripeApi,settings:ValidatedLiveSettings,
  orderId:number,buyerId:number){
  if(!Number.isSafeInteger(orderId)||orderId<=0||
     !Number.isSafeInteger(buyerId)||buyerId<=0)
    throw new LiveGateError('INVALID_ORDER_ID');
  const order=await store.reserveForPayment(orderId,buyerId,settings.maxOrderMinor);
  assertOrder(order,buyerId,settings);
  if(order!.intentId!==reserved&&!/^pi_[A-Za-z0-9]+$/.test(order!.intentId??''))
    throw new LiveGateError('ORDER_RESERVATION_NOT_ATOMIC');
  const metadata={tala_mode:'rc8_live_pickup',order_id:String(orderId),
    buyer_id:String(buyerId)};
  const intent=order!.intentId===reserved
    ? await provider.paymentIntents.create({
        amount:order!.amountMinor,currency:'mxn',
        allowed_payment_method_types:['card'],
        automatic_payment_methods:{enabled:true,allow_redirects:'never'},
        capture_method:'automatic',metadata,
        description:'Tala Eats pedido '+orderId,
      },{idempotencyKey:'tala-live-v1-pickup-order-'+orderId})
    : await provider.paymentIntents.retrieve(order!.intentId!);
  if((order!.intentId!==reserved&&intent.id!==order!.intentId)||
     !intent.livemode||intent.currency!=='mxn'||intent.amount!==order!.amountMinor||
     intent.metadata.tala_mode!==metadata.tala_mode||
     intent.metadata.order_id!==metadata.order_id||
     intent.metadata.buyer_id!==metadata.buyer_id||
     !/^pi_[A-Za-z0-9]+$/.test(intent.id))
    throw new LiveGateError('STRIPE_OBJECT_MISMATCH');
  // No reopening a captured, processing or canceled intent.
  if(!['requires_payment_method','requires_confirmation','requires_action'].includes(intent.status)||
     !intent.client_secret)
    throw new LiveGateError('PAYMENT_ALREADY_PROCESSING_OR_FINAL');
  if(order!.intentId===reserved&&
    !await store.attachStripeIntent(orderId,buyerId,intent.id))
    throw new LiveGateError('INTENT_POINTER_CAS_FAILED_RECONCILE_MANUALLY');
  return {provider:'stripe',mode:'live',order_id:orderId,
    payment_intent_id:intent.id,client_secret:intent.client_secret,
    publishable_key:settings.publishableKey,amount_minor:intent.amount,currency:'mxn'};
}
export function verifyLiveStripeEvent(
  provider:Pick<Stripe,'webhooks'>,settings:ValidatedLiveSettings,
  rawBody:Buffer,signature:string):Stripe.Event{
  if(!Buffer.isBuffer(rawBody)||rawBody.length===0||rawBody.length>1024*1024||
     typeof signature!=='string'||!signature)
    throw new LiveGateError('SIGNED_RAW_WEBHOOK_REQUIRED');
  const event=provider.webhooks.constructEvent(rawBody,signature,settings.webhookSecret);
  if(!event.livemode)throw new LiveGateError('STRIPE_TEST_EVENT_FORBIDDEN');
  if(event.account)throw new LiveGateError('CONNECTED_ACCOUNT_EVENT_NOT_SUPPORTED');
  return event;
}
export function verifyCapturedPickup(
 intent:Stripe.PaymentIntent,order:{id:number;buyerId:number;amountMinor:number}){
  return liveReceiptIdentity(intent,order);
}
