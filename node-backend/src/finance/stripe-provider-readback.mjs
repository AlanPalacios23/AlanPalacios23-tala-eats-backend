/**
 * RC13.8 Stripe LIVE pickup provider readback: deterministic, no mutations.
 * A captured PaymentIntent proves the sale; the BalanceTransaction separately
 * proves provider fees/net. Never infer a bank/Wallet balance from either.
 */
const int=(x)=>Number.isSafeInteger(x)&&x>=0;
const str=(x)=>typeof x==='string'?x:'';
const amount=(x)=>{
 const s=str(x);
 if(!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(s))throw Error('INVALID_MONEY');
 const [whole,fraction='']=s.split('.');
 return Number(BigInt(whole)*100n+BigInt((fraction+'00').slice(0,2)));
};
const ref=(raw)=>typeof raw==='string'?raw:raw?.id;
export function auditStripeCapturedBalance(order,pi,charge,tx){
 const reasons=[];
 if(!order||!pi||!charge||!tx)return {
   pass:false,findings:['PROVIDER_READBACK_INCOMPLETE'],bankSettled:false};
 let gross,fee;
 try{
   gross=amount(order.total);
   fee=amount(order.paymentProcessingFee);
 }catch{return {pass:false,findings:['ORDER_MONEY_INVALID'],bankSettled:false};}
 if(!/^pi_[A-Za-z0-9]+$/.test(str(order.paymentProviderId))||
    pi.id!==order.paymentProviderId||!pi.livemode||
    pi.status!=='succeeded'||pi.currency!=='mxn'||
    pi.amount!==gross||pi.amount_received!==gross)
   reasons.push('PAYMENT_INTENT_MISMATCH');
 if(!/^ch_[A-Za-z0-9]+$/.test(str(charge.id))||
    ref(pi.latest_charge)!==charge.id||
    ref(charge.payment_intent)!==pi.id||
    charge.livemode!==true||charge.paid!==true||charge.captured!==true||
    charge.currency!=='mxn'||charge.amount_captured!==gross)
   reasons.push('CHARGE_CAPTURE_MISMATCH');
 if(!/^txn_[A-Za-z0-9]+$/.test(str(tx.id))||
    ref(charge.balance_transaction)!==tx.id||ref(tx.source)!==charge.id||
    tx.currency!=='mxn'||!int(tx.amount)||!int(tx.fee)||
    !Number.isSafeInteger(tx.net)||
    tx.amount!==gross||tx.amount-tx.fee!==tx.net)
   reasons.push('BALANCE_TRANSACTION_MISMATCH');
 if(!int(tx.fee)||tx.fee!==fee)
   reasons.push('PROCESSING_FEE_NOT_RECONCILED');
 return {pass:reasons.length===0,findings:reasons,
   providerGrossMinor:tx.amount,providerFeeMinor:tx.fee,
   providerNetMinor:tx.net,bankSettled:false};
}
