/**
 * Stripe TEST only: no LIVE charges, Connect, transfers, payouts or refunds.
 * Server owns amounts; authenticated buyers only receive their own client_secret.
 * An order is not released to merchants until a verified TEST webhook confirms it.
 */
import type Stripe from 'stripe';
import { db } from './db.js';
import { config } from './config.js';
import { stripe } from './stripe.js';

export const STRIPE_INTENT_RESERVATION='pi_reserving_rc7';

export class TestPaymentError extends Error {
  constructor(public readonly code:number, message:string) { super(message); }
}

const moneyMinor=(value:string):number=>{
  if(!/^(?:0|[1-9]\d{0,7})\.\d{2}$/.test(value))
    throw new TestPaymentError(503,'Total fuera del contrato monetario');
  const [major,cents]=value.split('.');
  const amount=Number(major)*100+Number(cents);
  // Stripe limit and an explicit upper bound protect accidental TEST totals.
  if(!Number.isSafeInteger(amount)||amount<=0||amount>99_999_999)
    throw new TestPaymentError(503,'Total inválido para Stripe TEST');
  return amount;
};
const ensureTestReady=()=>{
  if(config.STAGE_STRIPE_TEST_CHECKOUT_ENABLED!=='true'||
     !stripe||!config.STRIPE_SECRET_KEY?.startsWith('sk_test_')||
     !config.STRIPE_WEBHOOK_SECRET||!config.STRIPE_PUBLISHABLE_KEY?.startsWith('pk_test_'))
    throw new TestPaymentError(503,'Stripe TEST no está habilitado');
  return stripe;
};

export async function createTestPaymentIntent(orderId:number,buyerId:number) {
  const provider=ensureTestReady();
  const order=await db.marketOrder.findUnique({where:{id:orderId}});
  // Never expose a payment client secret to an administrator or another buyer.
  if(!order||order.userId!==buyerId)
    throw new TestPaymentError(404,'Pedido no encontrado');
  if(order.orderType!=='pickup'||order.paymentMethod!=='stripe'||
     order.paymentProvider!=='stripe'||order.paymentStatus!=='pending'||
     order.status!=='awaiting_payment'||order.cancelledReason||
     order.refundedAmount.toString()!=='0')
    throw new TestPaymentError(409,'Pedido no apto para cobrar en Stripe TEST');
  // Keep recovery within the Stripe idempotency retention window. An older
  // reserved order MUST be reviewed, never silently create a second charge.
  if(Date.now()-order.createdAt.getTime()>30*60*1000)
    throw new TestPaymentError(409,'Pedido de tarjeta vencido; requiere revisión');
  const amount=moneyMinor(order.total.toFixed(2));
  const metadata={order_id:String(order.id),buyer_id:String(buyerId),mode:'rc7_test_pickup'};
  const requestKey='tala-node-stage-payment-intent-'+order.id+'-v1';
  let pointer=order.paymentProviderId;
  if(!pointer){
    // Reserve BEFORE contacting Stripe. If network times out, retries use
    // the same provider idempotency key; no cancel/expiry may restore stock
    // while a payment creation could still be in flight.
    const claimed=await db.marketOrder.updateMany({
      where:{id:order.id,paymentProviderId:'',paymentStatus:'pending',
        status:'awaiting_payment'},
      data:{paymentProviderId:STRIPE_INTENT_RESERVATION},
    });
    if(claimed.count!==1){
      const latest=await db.marketOrder.findUnique({where:{id:order.id}});
      if(!latest||latest.paymentStatus!=='pending'||
         latest.status!=='awaiting_payment')
        throw new TestPaymentError(409,'Pedido modificado durante el checkout');
      pointer=latest.paymentProviderId;
    }else pointer=STRIPE_INTENT_RESERVATION;
  }
  if(pointer!==STRIPE_INTENT_RESERVATION&&!/^pi_[A-Za-z0-9]+$/.test(pointer))
    throw new TestPaymentError(503,'Referencia de proveedor inválida');
  const intent=pointer===STRIPE_INTENT_RESERVATION
    ? await provider.paymentIntents.create({
        amount,currency:'mxn',automatic_payment_methods:{enabled:true},capture_method:'automatic',
        metadata,description:'Tala Eats pedido TEST #'+order.id,
      },{idempotencyKey:requestKey})
    : await provider.paymentIntents.retrieve(pointer);
  if(intent.livemode||intent.amount!==amount||intent.currency!=='mxn'||
     intent.metadata.order_id!==String(order.id)||
     intent.metadata.buyer_id!==String(buyerId)||
     intent.metadata.mode!=='rc7_test_pickup'||
     !intent.client_secret||intent.status==='canceled')
    throw new TestPaymentError(503,'Stripe TEST devolvió un intento inconsistente');

  if(pointer===STRIPE_INTENT_RESERVATION){
    const claimed=await db.marketOrder.updateMany({
      where:{id:order.id,paymentProviderId:STRIPE_INTENT_RESERVATION,
        paymentStatus:'pending',status:'awaiting_payment'},
      data:{paymentProviderId:intent.id},
    });
    if(claimed.count!==1){
      const latest=await db.marketOrder.findUnique({where:{id:order.id}});
      if(latest?.paymentProviderId!==intent.id||
         latest.paymentStatus!=='pending'||latest.status!=='awaiting_payment')
        throw new TestPaymentError(409,'Intento de pago concurrente; revisar pedido');
    }
  }
  return {
    provider:'stripe',mode:'test',order_id:order.id,
    payment_intent_id:intent.id,client_secret:intent.client_secret,
    publishable_key:config.STRIPE_PUBLISHABLE_KEY,
    amount_minor:amount,currency:'mxn',
  };
}

/**
 * Cancel a TEST PaymentIntent before an unpaid pickup order can release stock.
 * This does not refund captured payments. Any ambiguous PSP state stays held.
 */
export async function cancelUnpaidStripeTestIntent(orderId:number,actorId:number):
Promise<string>{
  const provider=ensureTestReady();
  const order=await db.marketOrder.findUnique({where:{id:orderId}});
  if(!order||order.userId!==actorId)
    throw new TestPaymentError(404,'Pedido no encontrado');
  if(order.orderType!=='pickup'||order.paymentMethod!=='stripe'||
     order.paymentStatus!=='pending'||order.status!=='awaiting_payment')
    throw new TestPaymentError(409,'Pago ya confirmado o pedido no cancelable');
  const pointer=order.paymentProviderId;
  // The reservation may represent a provider request still in flight.
  if(pointer===STRIPE_INTENT_RESERVATION)
    throw new TestPaymentError(409,'Creación Stripe en curso: conciliación requerida');
  if(pointer==='')return pointer;
  if(!/^pi_[A-Za-z0-9]+$/.test(pointer))
    throw new TestPaymentError(503,'Referencia Stripe inconsistente');
  let intent=await provider.paymentIntents.retrieve(pointer);
  if(intent.livemode||intent.amount!==moneyMinor(order.total.toFixed(2))||
     intent.currency!=='mxn'||intent.metadata.order_id!==String(orderId)||
     intent.metadata.buyer_id!==String(actorId)||
     intent.metadata.mode!=='rc7_test_pickup')
    throw new TestPaymentError(503,'Pago Stripe TEST no coincide con el pedido');
  if(intent.status!=='canceled'){
    // Fail closed if the card was captured or is in an ambiguous state.
    if(!['requires_payment_method','requires_confirmation','requires_action'].includes(intent.status)||
       intent.amount_received!==0)
      throw new TestPaymentError(409,'Stripe no permite cancelar este intento sin revisión');
    intent=await provider.paymentIntents.cancel(pointer,{cancellation_reason:'requested_by_customer'},
      {idempotencyKey:'tala-stage-cancel-pi-'+orderId+'-v1'});
  }
  if(intent.status!=='canceled'||intent.amount_received!==0)
    throw new TestPaymentError(503,'Cancelación de Stripe TEST no verificada');
  return pointer;
}

/**
 * The webhook HTTP endpoint already checked Stripe-Signature and rejected LIVE.
 * Re-fetch the event + PaymentIntent from Stripe to resist tampered/stale jobs.
 * For this stage slice we only release pickup orders after a verified success.
 */
export async function processStripeTestReceipt(eventId:string):Promise<void>{
  const provider=ensureTestReady();
  if(!/^evt_[A-Za-z0-9]+$/.test(eventId))
    throw new TestPaymentError(422,'ID de evento inválido');
  const event=await provider.events.retrieve(eventId);
  if(event.livemode)throw new TestPaymentError(403,'Evento LIVE prohibido');
  if(!['payment_intent.succeeded','payment_intent.payment_failed',
        'payment_intent.canceled'].includes(event.type))return;
  const object=event.data.object as Stripe.PaymentIntent;
  if(object.object!=='payment_intent'||!/^pi_[A-Za-z0-9]+$/.test(object.id))
    throw new TestPaymentError(503,'Evento Stripe inesperado');
  const intent=await provider.paymentIntents.retrieve(object.id);
  const orderId=Number(intent.metadata.order_id),buyerId=Number(intent.metadata.buyer_id);
  if(!Number.isSafeInteger(orderId)||orderId<=0||!Number.isSafeInteger(buyerId)||
     buyerId<=0||intent.metadata.mode!=='rc7_test_pickup'||intent.livemode||
     intent.currency!=='mxn')
    throw new TestPaymentError(503,'Evento sin referencia de pedido TEST válida');

  await db.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM stripe_webhook_events WHERE id=${eventId} FOR UPDATE`;
    const receipt=await tx.stripeWebhookEvent.findUnique({where:{id:eventId}});
    if(!receipt||receipt.type!==event.type||receipt.objectId!==object.id)
      throw new TestPaymentError(503,'Evento recibido no coincide');
    if(receipt.status==='PROCESSED')return;
    await tx.$queryRaw`SELECT id FROM orders WHERE id=${orderId} FOR UPDATE`;
    const order=await tx.marketOrder.findUnique({where:{id:orderId}});
    if(!order||order.userId!==buyerId||order.orderType!=='pickup'||
       order.paymentMethod!=='stripe'||order.paymentProvider!=='stripe'||
       order.paymentProviderId!==intent.id||
       moneyMinor(order.total.toFixed(2))!==intent.amount)
      throw new TestPaymentError(503,'Pago TEST sin orden válida: reconciliación manual');
    if(event.type==='payment_intent.succeeded'){
      if(intent.status!=='succeeded'||intent.amount_received!==intent.amount)
        throw new TestPaymentError(503,'Stripe todavía no confirmó el cobro');
      if(order.status!=='awaiting_payment'&&order.paymentStatus!=='paid')
        throw new TestPaymentError(503,'Pedido modificado: reconciliación manual');
      if(order.paymentStatus!=='paid') {
        const changed=await tx.marketOrder.updateMany({
          where:{id:orderId,paymentStatus:'pending',status:'awaiting_payment'},
          data:{paymentStatus:'paid',status:'received'},
        });
        if(changed.count!==1)
          throw new TestPaymentError(503,'Conflicto en confirmación de pago');
        await tx.stageFinancialLedgerEntry.create({
          data:{
            orderId,userId:buyerId,restaurantId:order.restaurantId,
            account:'stripe_test_collected',direction:'credit',
            amount:order.total,kind:'stripe_test_payment',
            description:'Pago verificado Stripe TEST: no transferible',
            idempotencyKey:'order:'+orderId+':stripe-test:collected',
          },
        });
        await tx.stageOrderEvent.create({
          data:{orderId,status:'received',actorUserId:buyerId,
            metadataJson:JSON.stringify({source:'stripe_test_webhook',stripe_event_id:eventId})},
        });
        await tx.authNotification.create({
          data:{userId:buyerId,kind:'order',title:'Pago TEST confirmado',
            message:'Pedido de prueba #'+orderId+' listo para procesarse.'},
        });
        await tx.stageEventOutbox.create({
          data:{eventKey:'order:'+orderId+':stripe-test-paid',
            aggregateType:'order',aggregateId:String(orderId),eventType:'order.paid',
            payloadJson:JSON.stringify({order_id:orderId,status:'received',payment_status:'paid'})},
        });
      }
    }
    // Failures and cancels NEVER mark a customer order paid; stock remains
    // reserved until a separately reviewed cancel/expiry compensation path exists.
    await tx.stripeWebhookEvent.update({
      where:{id:eventId},data:{status:'PROCESSED',processedAt:new Date()},
    });
  },{maxWait:10_000,timeout:20_000});
}
