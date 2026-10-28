// TALA EATS Phase C2: isolated cash/pickup lifecycle, no external money.
// Source contracts: backend/app/routes/{orders,owner}.py, inventory.py.
// No LIVE, no PSP, no customer wallet or driver/dispatch writes.
import { db } from '../db.js';
import {dispatchStageDeliveryReady} from './driver.js';
import {liveDispatchReleased,liveDeliveryTenderAllowed} from './live-delivery-payment.js';
import { config } from '../config.js';
import {cancelUnpaidStripeTestIntent} from '../stage-stripe-test.js';
import type { AuthUser, MarketOrder } from '../generated/prisma/client.js';

class LifecycleError extends Error {
  constructor(public readonly code:number,message:string){super(message);}
}
const notFound=():never=>{throw new LifecycleError(404,'Pedido no encontrado');};
const fail=(code:number,message:string):never=>{throw new LifecycleError(code,message);};
const cents=(v:string):bigint=>{
  if(!/^-?(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/.test(v))
    throw new LifecycleError(503,'Importe no compatible con el ciclo de staging');
  const neg=v.startsWith('-');
  const [whole,part='']=(neg?v.slice(1):v).split('.');
  const out=BigInt(whole!)*100n+BigInt((part+'00').slice(0,2));
  return neg?-out:out;
};
const dollars=(n:bigint):string=>{
  const abs=n<0n?-n:n;
  return (n<0n?'-':'')+(abs/100n).toString()+'.'+(abs%100n).toString().padStart(2,'0');
};
const milli=(v:string):bigint=>{
  if(!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,3})?$/.test(v))
    throw new LifecycleError(503,'Reserva de ingrediente inválida');
  const [a,b='']=v.split('.');
  return BigInt(a!)*1000n+BigInt((b+'000').slice(0,3));
};
const fromMilli=(n:bigint):string=>(n/1000n).toString()+'.'+(n%1000n).toString().padStart(3,'0');
// Python orders.py cancellation uses Decimal.quantize(Decimal("0.01"))
// WITHOUT an explicit rounding override: Python's default ROUND_HALF_EVEN.
// This differs from monetization.money() which explicitly uses HALF_UP.
// Use exact integer arithmetic to preserve ties-to-even, including 0.005 MXN.
const roundHalfEvenBasisPoints=(minor:bigint,rate:bigint):bigint=>{
  if(minor<0n||rate<0n)throw new LifecycleError(503,'Base de cancelación inválida');
  const whole=minor*rate/10000n;
  const remainder=minor*rate%10000n;
  if(remainder>5000n||(remainder===5000n&&whole%2n!==0n))
    return whole+1n;
  return whole;
};
const feeRates:{[key:string]:bigint}={received:0n,confirmed:1000n,preparing:3000n};
const cashOnly=(o:MarketOrder):void=>{
  const eligiblePickup=o.orderType==='pickup'&&
    config.STAGE_PICKUP_CASH_CHECKOUT_ENABLED==='true';
  const eligibleDelivery=o.orderType==='delivery'&&
    config.NODE_ENV==='staging'&&
    config.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED==='true';
  if(!(eligiblePickup||eligibleDelivery)||
     o.paymentMethod!=='cash'||o.paymentStatus!=='pending')
    fail(503,'Este flujo de staging sólo admite pedidos cash sin pagos capturados');
};
export async function previewCancelStage(orderId:number,actor:AuthUser) {
  if(!['customer','admin'].includes(actor.role))fail(403,'No autorizado');
  const order=await db.marketOrder.findUnique({where:{id:orderId}});
  if(!order||(actor.role!=='admin'&&order.userId!==actor.id))return notFound();
  if(order.paymentMethod==='stripe'&&
     (order.orderType==='pickup'||(order.orderType==='delivery'&&
       config.NODE_ENV==='staging'&&
       config.STAGE_DELIVERY_STRIPE_TEST_ENABLED==='true'))&&
     config.STAGE_STRIPE_TEST_CHECKOUT_ENABLED==='true'){
    if(order.status==='awaiting_payment'&&order.paymentStatus==='pending'&&
       order.paymentProviderId!=='pi_reserving_rc7'){
      return {cancellable:true,status:order.status,fee:'0.00',
        refund_estimate:'0.00',policy:'Stripe TEST: no hay cargo; primero cancelar PaymentIntent'};
    }
    return {cancellable:false,reason:'Pago Stripe pendiente de conciliación; soporte',
      fee:'0.00'};
  }
  cashOnly(order);
  if(order.status==='cancelled')
    return {cancellable:true,status:'cancelled',fee:dollars(cents(order.cancellationFee.toString())),
      refund_estimate:dollars(0n),policy:'Pedido ya cancelado'};
  const applicable=actor.role==='admin'||order.status in feeRates;
  if(!applicable)
    return {cancellable:false,reason:'Requiere revisión de soporte',fee:'0.00'};
  if(!(order.status in feeRates))fail(503,'Cancelación administrativa posterior pendiente');
  const rate=actor.role==='admin'?0n:feeRates[order.status]!;
  const rounded=roundHalfEvenBasisPoints(
    cents(order.subtotal.toString())-cents(order.discount.toString()),rate);
  const total=cents(order.total.toString());
  return {cancellable:true,status:order.status,fee:dollars(rounded),
    refund_estimate:dollars(total>rounded?total-rounded:0n),
    policy:'received=gratis, confirmed=10%, preparing=30%; estados posteriores requieren soporte'};
}
// Single-row lock serializes cancel/cancel and cancel/merchant-transition races.
// Every stock restore, ledger compensation, event and notification is committed
// atomically with the inventory_restored_at marker and cancelled status.
export async function cancelCashPickupStage(
  orderId:number, actor:AuthUser, reason:string='Cambio de planes',
):Promise<number>{
  const candidate=await db.marketOrder.findUnique({where:{id:orderId},
    select:{userId:true,orderType:true,paymentMethod:true,status:true}});
  if(!candidate)return notFound();
  const stripe=candidate.paymentMethod==='stripe'&&(
    candidate.orderType==='pickup'||(
    candidate.orderType==='delivery'&&
    config.NODE_ENV==='staging'&&
    config.STAGE_DELIVERY_STRIPE_TEST_ENABLED==='true'));
  if(stripe&&actor.role!=='customer')
    fail(403,'Solo el comprador puede cancelar un Stripe TEST sin cargo');
  if(stripe&&candidate.userId!==actor.id)return notFound();
  if(stripe&&config.STAGE_STRIPE_TEST_CHECKOUT_ENABLED!=='true')
    fail(503,'Stripe TEST deshabilitado');
  if(!stripe&&config.STAGE_PICKUP_CASH_CHECKOUT_ENABLED!=='true'&&
     config.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED!=='true')
    fail(503,'Ciclo de pedidos de staging deshabilitado');
  if(stripe&&candidate.status==='cancelled')return orderId;
  // Stripe confirms no capture BEFORE entering the stock restoration transaction.
  // A concurrent PaymentIntent creation is reserved in DB and blocks cancellation.
  const canceledIntent=stripe
    ?await cancelUnpaidStripeTestIntent(orderId,actor.id):null;
  return db.$transaction(async tx=>{
    const locks=await tx.$queryRaw<{id:number}[]>`
      SELECT id FROM orders WHERE id=${orderId} FOR UPDATE
    `;
    if(!locks.length)return notFound();
    const order=await tx.marketOrder.findUnique({
      where:{id:orderId},include:{restaurant:true,items:true},
    });
    if(!order)return notFound();
    if(actor.role==='customer'&&order.userId!==actor.id)return notFound();
    if(actor.role==='restaurant'&&order.restaurant.ownerId!==actor.id)
      fail(403,'Ese pedido no pertenece a tu restaurante');
    if(!['customer','restaurant','admin'].includes(actor.role))
      fail(403,'No autorizado');
    if(stripe){
      if(!(order.orderType==='pickup'||(order.orderType==='delivery'&&
            config.NODE_ENV==='staging'&&
            config.STAGE_DELIVERY_STRIPE_TEST_ENABLED==='true'))||
         order.paymentMethod!=='stripe'||
         order.status!=='awaiting_payment'||order.paymentStatus!=='pending'||
         order.paymentProviderId!==canceledIntent)
        fail(409,'El intento Stripe cambió: inventario retenido para conciliación');
    }else cashOnly(order);
    // Idempotent status: second cancel does not restore stock, create events
    // or post accounting reversals.
    if(order.status==='cancelled')return order.id;
    if(!stripe&&!(order.status in feeRates))
      fail(400,'El pedido ya no puede cancelarse automáticamente; abre una disputa o contacta soporte');
    // Restrict mutation to C1 checkout-created orders, not imported Python
    // or synthetic legacy records without trusted checkout fingerprint.
    const received=await tx.stageOrderEvent.findFirst({
      where:{orderId:order.id,status:'received'},orderBy:{id:'asc'},
    });
    let fingerprint:unknown;
    try{fingerprint=JSON.parse(received?.metadataJson??'{}').checkout_intent_hmac;}catch{}
    if(typeof fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(fingerprint))
      fail(503,'Este pedido no tiene evidencia de checkout de staging');
    if(order.inventoryRestoredAt!==null)
      fail(409,'El inventario del pedido ya fue restaurado');
    let reservations:Record<string,unknown>;
    try{
      const parsed:unknown=JSON.parse(order.inventoryReservedJson);
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))
        throw Error('not-object');
      reservations=parsed as Record<string,unknown>;
    }catch{ return fail(503,'Snapshot de inventario inválido'); }
    const itemTotals=new Map<number,number>();
    for(const item of order.items){
      if(item.menuItemId===null||item.quantity<=0||!Number.isSafeInteger(item.quantity))
        fail(503,'Líneas históricas no compatibles para restauración');
      itemTotals.set(item.menuItemId!, (itemTotals.get(item.menuItemId!)??0)+item.quantity);
    }
    if(!itemTotals.size)fail(503,'No existe inventario que restaurar');
    const ingredients=new Map<number,bigint>();
    for(const [rawId,value] of Object.entries(reservations)){
      const id=Number(rawId);
      if(!Number.isSafeInteger(id)||id<=0)
        return fail(503,'Snapshot de ingrediente inválido');
      if(typeof value!=='string')
        return fail(503,'Snapshot de ingrediente inválido');
      const amount=milli(value);
      if(amount<=0n)fail(503,'Snapshot de ingrediente inválido');
      ingredients.set(id,amount);
    }
    const ledger=await tx.stageFinancialLedgerEntry.findMany({
      where:{orderId:order.id,kind:'order_settlement'},orderBy:{id:'asc'},
    });
    // An unpaid Stripe TEST reservation must have ZERO revenue/payable
    // accruals. Captured Stripe payments are never canceled through this path.
    if(stripe&&ledger.length!==0)
      fail(503,'Pedido Stripe sin captura contiene saldos: revisión contable');
    if(!stripe){
      // Zero platform income / contribution may be intentionally omitted for
      // small cash orders. Never require a zero-valued ledger entry.
      const required=['gmv','restaurant_payable'];
      if(cents(order.platformRevenue.toString())!==0n)required.push('platform_revenue');
      if(!required.every(a=>ledger.some(e=>e.account===a))||
         new Set(ledger.map(e=>e.account)).size!==ledger.length)
        fail(503,'Ledger de checkout incompleto o duplicado; no se puede cancelar');
    }
    const feeRate=stripe?0n:actor.role==='customer'?feeRates[order.status]!:0n;
    const cancellationFee=roundHalfEvenBasisPoints(
      cents(order.subtotal.toString())-cents(order.discount.toString()),feeRate);

    for(const id of [...itemTotals.keys()].sort((a,b)=>a-b)){
      const qty=itemTotals.get(id)!;
      const updated=await tx.$queryRaw<{id:number}[]>`
        UPDATE menu_items SET stock=stock+${qty} WHERE id=${id}
        AND restaurant_id=${order.restaurantId}
        AND stock <= 2147483647-${qty} RETURNING id
      `;
      if(updated.length!==1)fail(503,'Inventario menú no restaurable');
    }
    for(const id of [...ingredients.keys()].sort((a,b)=>a-b)){
      const qty=fromMilli(ingredients.get(id)!);
      const updated=await tx.$queryRaw<{id:number}[]>`
        UPDATE ingredient_stocks SET quantity=quantity+${qty}::numeric
        WHERE id=${id} AND restaurant_id=${order.restaurantId}
        RETURNING id
      `;
      if(updated.length!==1)fail(503,'Inventario de ingredientes no restaurable');
    }
    const when=new Date();
    await tx.marketOrder.update({
      where:{id:order.id},
      data:{status:'cancelled',inventoryRestoredAt:when,
        ...(stripe?{paymentStatus:'expired'}:{}),
        cancelledReason:reason.slice(0,300),cancellationFee:dollars(cancellationFee)},
    });
    await tx.stageOrderEvent.create({data:{
      orderId:order.id,status:'cancelled',actorUserId:actor.id,
      metadataJson:JSON.stringify({source:stripe?'stripe_test_cancelled':actor.role,
        cancellation_fee:dollars(cancellationFee)}),
    }});
    await tx.stageEventOutbox.create({data:{
      eventKey:'order:'+order.id+':cancelled',aggregateType:'order',
      aggregateId:String(order.id),eventType:'order.status',
      payloadJson:JSON.stringify({order_id:order.id,status:'cancelled',
        payment_status:stripe?'expired':order.paymentStatus}),
    }});
    // Original order settlement was an accrual: reverse it with new immutable
    // debit entries, NOT edits to existing ledger. For unpaid CASH orders,
    // cancellation_fee is a disclosure estimate, not an actual collected fee.
    for(const old of ledger){
      await tx.stageFinancialLedgerEntry.create({data:{
        orderId:order.id,userId:order.userId,restaurantId:order.restaurantId,
        account:old.account,direction:old.direction==='credit'?'debit':'credit',
        amount:old.amount,kind:'order_cancellation',
        description:stripe?'Reverso pedido tarjeta TEST no capturado':'Reverso efectivo no cobrado',
        idempotencyKey:'order:'+order.id+':cancel:reverse:'+old.account,
      }});
    }
    await tx.authNotification.create({data:{
      userId:order.userId,kind:'order',title:'Pedido cancelado',
      message:'Tu pedido #'+order.id+' fue cancelado.',
    }});
    if(order.restaurant.ownerId){
      await tx.authNotification.create({data:{
        userId:order.restaurant.ownerId,kind:'restaurant_order',
        title:'Pedido cancelado',message:'Pedido #'+order.id+' cancelado.',
      }});
    }
    return order.id;
  },{maxWait:10_000,timeout:20_000});
}
export async function moveStagePickupOwner(orderId:number,actor:AuthUser,
  next:'confirmed'|'preparing'|'ready'):Promise<number>{
  const liveCardEnabled=config.NODE_ENV==='production'&&
    config.STRIPE_LIVE_ENABLED==='true'&&
    config.STRIPE_FINANCIAL_WRITES_ENABLED==='true';
  if(config.STAGE_PICKUP_CASH_CHECKOUT_ENABLED!=='true'&&
     config.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED!=='true'&&
     config.STAGE_STRIPE_TEST_CHECKOUT_ENABLED!=='true'&&!liveCardEnabled)
    fail(503,'Ciclo de pedidos de recogida deshabilitado');
  if(!['restaurant','admin'].includes(actor.role))fail(403,'No autorizado');
  const resultId=await db.$transaction(async tx=>{
    const locks=await tx.$queryRaw<{id:number}[]>`
      SELECT id FROM orders WHERE id=${orderId} FOR UPDATE
    `;
    if(!locks.length)return notFound();
    const order=await tx.marketOrder.findUnique({
      where:{id:orderId},include:{restaurant:true},
    });
    if(!order)return notFound();
    if(actor.role!=='admin'&&order.restaurant.ownerId!==actor.id)
      fail(403,'Ese pedido no pertenece a tu restaurante');
    const cash=order.paymentMethod==='cash'&&
      order.paymentStatus==='pending'&&(
       (order.orderType==='pickup'&&
        config.STAGE_PICKUP_CASH_CHECKOUT_ENABLED==='true')||
       (order.orderType==='delivery'&&config.NODE_ENV==='staging'&&
        config.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED==='true'));
    const stripe=(order.orderType==='pickup'||
      (order.orderType==='delivery'&&
       ((config.NODE_ENV==='staging'&&
         config.STAGE_DELIVERY_STRIPE_TEST_ENABLED==='true')||
        (config.NODE_ENV==='production'&&liveDispatchReleased()))))&&
      order.paymentMethod==='stripe'&&
      order.paymentStatus==='paid'&&
      (config.STAGE_STRIPE_TEST_CHECKOUT_ENABLED==='true'||liveCardEnabled);
    if(!cash&&!stripe)fail(503,'Pago no conciliado o método no disponible');
    if(stripe){
      if(order.orderType==='delivery'&&config.NODE_ENV==='production'&&
         !await liveDeliveryTenderAllowed(tx,order))
        fail(503,'Entrega sin cobro Stripe firmado y conciliado o con riesgo abierto');
      const live=liveCardEnabled;
      const verified=await tx.stageFinancialLedgerEntry.findFirst({
        where:{orderId:order.id,
          kind:live?'stripe_live_payment':'stripe_test_payment',
          account:live?'stripe_live_collected':'stripe_test_collected',
          direction:'credit',
          idempotencyKey:live?
            'order:'+order.id+':stripe-live:collected':
            'order:'+order.id+':stripe-test:collected'},
      });
      if(!verified||verified.amount.toFixed(2)!==order.total.toFixed(2))
        fail(503,'El pedido carece de cobro Stripe firmado y contabilizado');
    }
    const expected:{[key:string]:string}={
      received:'confirmed',confirmed:'preparing',preparing:'ready',
    };
    if(expected[order.status]!==next)
      fail(409,'Transición inválida: '+order.status+' → '+next);
    const received=await tx.stageOrderEvent.findFirst({
      where:{orderId:order.id,status:'received'},orderBy:{id:'asc'},
    });
    let fingerprint:unknown;
    try{fingerprint=JSON.parse(received?.metadataJson??'{}').checkout_intent_hmac;}catch{}
    if(typeof fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(fingerprint))
      fail(503,'El pedido no tiene prueba de checkout staging');
    const stamp=new Date();
    await tx.marketOrder.update({
      where:{id:order.id},data:{
        status:next,
        ...(next==='confirmed'?{acceptedAt:stamp}:{}),
        ...(next==='preparing'?{preparingAt:stamp}:{}),
        ...(next==='ready'?{readyAt:stamp}:{}),
      },
    });
    await tx.stageOrderEvent.create({data:{
      orderId:order.id,status:next,actorUserId:actor.id,
      metadataJson:JSON.stringify({source:'restaurant'}),
    }});
    await tx.stageEventOutbox.create({data:{
      eventKey:'order:'+order.id+':status:'+next,
      aggregateType:'order',aggregateId:String(order.id),
      eventType:'order.status',payloadJson:JSON.stringify({
        order_id:order.id,status:next,driver_id:null,
      }),
    }});
    await tx.authNotification.create({data:{
      userId:order.userId,kind:'order',title:'Actualización de pedido',
      message:'Tu pedido #'+order.id+' cambió a '+next+'.',
    }});
    return order.id;
  },{maxWait:10_000,timeout:20_000});
  if(next==='ready'&&((config.NODE_ENV==='staging'&&
     config.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED==='true')||
     (config.NODE_ENV==='production'&&liveDispatchReleased()))){
    await dispatchStageDeliveryReady(resultId);
  }
  return resultId;
}

export const moveCashPickupOwnerStage=moveStagePickupOwner;
