/**
 * RC8.10 dispatch must not treat paymentStatus=paid as proof of a charge.
 * A non-zero signed-webhook Stripe TEST receipt, committed on exactly this
 * order and for its full total, is mandatory before merchant or driver work.
 * No provider API call and no real money movement here.
 */
import {config} from '../config.js';

type OrderForTender={
 id:number;orderType:string;paymentMethod:string;paymentStatus:string;
 total:{toFixed:(digits:number)=>string};
};
type Receipt={
 account:string;direction:string;kind:string;
 amount:{toFixed:(digits:number)=>string};
 idempotencyKey:string;
};
type Reader={
 stageFinancialLedgerEntry:{
  findUnique:(args:{where:{idempotencyKey:string}})=>Promise<Receipt|null>;
 };
};
export function matchesSignedStagePayment(order:OrderForTender,
 receipt:Receipt|null):boolean{
 return Boolean(receipt&&receipt.account==='stripe_test_collected'&&
  receipt.direction==='credit'&&receipt.kind==='stripe_test_payment'&&
  receipt.idempotencyKey==='order:'+order.id+':stripe-test:collected'&&
  receipt.amount.toFixed(2)===order.total.toFixed(2));
}
export async function stageDeliveryTenderAllowed(
 tx:Reader,order:OrderForTender):Promise<boolean>{
 if(order.orderType!=='delivery')return false;
 if(order.paymentMethod==='cash')
   return order.paymentStatus==='pending'&&
     config.NODE_ENV==='staging'&&
     config.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED==='true';
 if(order.paymentMethod!=='stripe'||order.paymentStatus!=='paid'||
    config.NODE_ENV!=='staging'||
    config.STAGE_DELIVERY_STRIPE_TEST_ENABLED!=='true'||
    config.STAGE_STRIPE_TEST_CHECKOUT_ENABLED!=='true')
   return false;
 const receipt=await tx.stageFinancialLedgerEntry.findUnique({
  where:{idempotencyKey:'order:'+order.id+':stripe-test:collected'},
 });
 return matchesSignedStagePayment(order,receipt);
}
