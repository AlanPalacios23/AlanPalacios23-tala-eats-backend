/**
 * RC13.0: isolated rehearsal state machine. NEVER maps to production order,
 * ledger, Stripe PaymentIntent, payout, financial account or stock records.
 */
export type RehearsalStatus =
 'new'|'placed'|'accepted'|'preparing'|'ready'|'assigned'|
 'picked_up'|'on_the_way'|'delivered'|'cancelled';
export type RehearsalAction='place'|'accept'|'prepare'|'ready'|
 'assign'|'pickup'|'depart'|'deliver'|'cancel';
export type Actor='customer'|'restaurant'|'driver'|'admin';
export type DemoMoney={
 subtotal_minor:number;service_minor:number;shipping_minor:number;
 total_minor:number;merchant_minor:number;driver_minor:number;platform_minor:number;
};
export type DemoRoom={
 id:string;version:number;adminId:number;customerId:number;restaurantId:number;
 driverId:number;status:RehearsalStatus;productName:string|null;
 quantity:number;unitPriceMinor:number;paymentMethod:'cash_demo'|'card_demo'|null;
 deliveryPin:string|null;createdAt:string;updatedAt:string;
};
export class RehearsalError extends Error{
 constructor(public readonly statusCode:number,reason:string){super(reason);}
}
const rule=(ok:boolean,msg:string)=>{
 if(!ok)throw new RehearsalError(409,msg);
};
export function demoMoney(room:DemoRoom):DemoMoney{
 if(room.status==='new'||room.status==='cancelled'||room.unitPriceMinor===0)
  return {subtotal_minor:0,service_minor:0,shipping_minor:0,
   total_minor:0,merchant_minor:0,driver_minor:0,platform_minor:0};
 const subtotal=room.unitPriceMinor*room.quantity;
 const fee=Math.round(subtotal*0.07),commission=Math.round(subtotal*0.15);
 const shipping=3900,driver=3200;
 return {subtotal_minor:subtotal,service_minor:fee,shipping_minor:shipping,
  total_minor:subtotal+fee+shipping,merchant_minor:subtotal-commission,
  driver_minor:driver,platform_minor:commission+fee+shipping-driver};
}
export function applyRehearsalAction(
 room:DemoRoom,actor:Actor,action:RehearsalAction,now:string,
 details?:{productName?:string;quantity?:number;unitPriceMinor?:number;
  paymentMethod?:'cash_demo'|'card_demo';pin?:string;expectedPin?:string}
):DemoRoom{
 if(room.status==='cancelled'||room.status==='delivered')
  throw new RehearsalError(409,'DEMO_ALREADY_FINISHED');
 const steps:Record<Exclude<RehearsalAction,'place'|'cancel'>,
   [RehearsalStatus,Actor,RehearsalStatus]>={
  accept:['placed','restaurant','accepted'],
  prepare:['accepted','restaurant','preparing'],
  ready:['preparing','restaurant','ready'],
  assign:['ready','driver','assigned'],
  pickup:['assigned','driver','picked_up'],
  depart:['picked_up','driver','on_the_way'],
  deliver:['on_the_way','driver','delivered'],
 };
 if(action==='cancel'){
  rule(actor==='admin','DEMO_ADMIN_REQUIRED');
  return {...room,status:'cancelled',version:room.version+1,updatedAt:now};
 }
 if(action==='place'){
  rule(actor==='customer'&&room.status==='new','DEMO_CUSTOMER_NEW_REQUIRED');
  const name=details?.productName?.trim()??'';
  const quantity=details?.quantity,price=details?.unitPriceMinor;
  rule(name.length>=2&&name.length<=100&&
   Number.isSafeInteger(quantity)&&Number(quantity)>=1&&Number(quantity)<=10&&
   Number.isSafeInteger(price)&&Number(price)>=100&&Number(price)<=50000&&
   ['cash_demo','card_demo'].includes(details?.paymentMethod??''),
   'DEMO_ORDER_INVALID');
  return {...room,status:'placed',productName:name,quantity:quantity!,
   unitPriceMinor:price!,paymentMethod:details!.paymentMethod!,
   version:room.version+1,updatedAt:now};
 }
 const step=steps[action];
 rule(Boolean(step)&&room.status===step?.[0]&&actor===step?.[1],
  'DEMO_TRANSITION_FORBIDDEN');
 if(action==='deliver')rule(details?.pin===details?.expectedPin&&
  typeof details?.pin==='string'&&/^[0-9]{4}$/.test(details.pin),
  'DEMO_PIN_INCORRECT');
 return {...room,status:step[2],version:room.version+1,updatedAt:now};
}
export function publicDemoRoom(room:DemoRoom,actor:Actor){
 const {deliveryPin,...safe}=room;
 const money=demoMoney(room);
 const done=room.status==='delivered';
 return {...safe,demo_only:true,payment_charged:false,
  real_order_id:null,real_stripe_payment_id:null,
  withdrawable:false,bank_balance_minor:0,
  mock_payment_status:room.paymentMethod==='card_demo'?'simulated_not_charged':
   'no_card_charge',money:{
   ...money,
   // Only money on delivered orders is shown as simulated wallet, never
   // payable, never a financial ledger record in the production database.
   merchant_demo_wallet_minor:done?money.merchant_minor:0,
   driver_demo_wallet_minor:done?money.driver_minor:0,
  },
  ...(actor==='customer'||actor==='admin'?{delivery_pin:deliveryPin}:{}),
 };
}
