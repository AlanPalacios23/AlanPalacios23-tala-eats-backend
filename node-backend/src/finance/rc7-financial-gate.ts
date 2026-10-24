/**
 * TALA EATS RC7 read-only financial deploy gate.
 * Queries are bounded and NEVER return person/order IDs, PII or secrets.
 * A stage code PASS does not authorize LIVE nor prove Stripe connectivity.
 */
import { db } from '../db.js';
import { config } from '../config.js';
import {classifyRc7FinancialData, type Rc7GateCounters} from './rc7-financial-gate-core.js';

export type Rc7FinancialGateResult={
  classification:'STAGE_FINANCIAL_DATA_PASS'|'STAGE_FINANCIAL_DATA_HOLD';
  productionReady:false;
  stripeMode:'test';
  inspectedPaidOrders:number;
  counters:Rc7GateCounters;
  issues:string[];
};

export async function inspectRc7FinancialData():Promise<Rc7FinancialGateResult>{
  if(config.NODE_ENV!=='staging'||config.STRIPE_FINANCIAL_WRITES_ENABLED!=='false')
    throw new Error('RC7_FINANCIAL_GATE_REQUIRES_TEST_STAGE');

  const now=Date.now();
  const staleProvider=new Date(now-10*60_000);
  const staleUnpaid=new Date(now-35*60_000);
  const staleReceipt=new Date(now-15*60_000);
  const [
    stuckIntentReservations,overdueUnpaidCardOrders,
    unreconciledSignedWebhooks,cardCashMisclassification,paidOrders,
  ]=await Promise.all([
    db.marketOrder.count({where:{
      paymentMethod:'stripe',paymentStatus:'pending',status:'awaiting_payment',
      paymentProviderId:'pi_reserving_rc7',createdAt:{lt:staleProvider},
    }}),
    db.marketOrder.count({where:{
      paymentMethod:'stripe',paymentStatus:'pending',
      status:'awaiting_payment',createdAt:{lt:staleUnpaid},
    }}),
    db.stripeWebhookEvent.count({where:{
      status:{in:['RECEIVED','FAILED']},receivedAt:{lt:staleReceipt},
      type:{in:['payment_intent.succeeded',
        'payment_intent.payment_failed','payment_intent.canceled']},
    }}),
    db.marketOrder.count({where:{
      paymentMethod:'stripe',cashCollected:{gt:'0.00'},
    }}),
    db.marketOrder.findMany({
      where:{paymentMethod:'stripe',paymentStatus:'paid'},
      orderBy:{id:'asc'},take:5001,
      select:{id:true,total:true},
    }),
  ]);
  let paidOrdersMissingTrustedReceipt=0;
  const paidOrderSampleTruncated=paidOrders.length>5000?1:0;
  if(!paidOrderSampleTruncated&&paidOrders.length>0){
    const receipts=await db.stageFinancialLedgerEntry.findMany({
      where:{orderId:{in:paidOrders.map(o=>o.id)},
        kind:'stripe_test_payment',account:'stripe_test_collected',
        direction:'credit'},
      select:{orderId:true,idempotencyKey:true,amount:true},
    });
    const buckets=new Map<number,number>();
    const lookup=new Map(paidOrders.map(o=>[o.id,o] as const));
    for(const receipt of receipts){
      const order=receipt.orderId===null?undefined:lookup.get(receipt.orderId);
      if(!order||receipt.idempotencyKey!=='order:'+order.id+':stripe-test:collected'||
         receipt.amount.toFixed(2)!==order.total.toFixed(2))continue;
      buckets.set(order.id,(buckets.get(order.id)??0)+1);
    }
    paidOrdersMissingTrustedReceipt=paidOrders.filter(
      o=>buckets.get(o.id)!==1).length;
  }
  const counters={
    stuckIntentReservations,overdueUnpaidCardOrders,
    unreconciledSignedWebhooks,paidOrdersMissingTrustedReceipt,
    cardCashMisclassification,paidOrderSampleTruncated,
  };
  const classification=classifyRc7FinancialData(counters);
  return {
    classification,productionReady:false,stripeMode:'test',
    inspectedPaidOrders:Math.min(5000,paidOrders.length),
    counters,issues:Object.entries(counters).filter(([,v])=>v>0).map(([k])=>k),
  };
}

// Explicit operator command only; never run at module import (worker/API).
// This script does not call Stripe, process payments or change any table.
if(process.argv[1]&&
   (process.argv[1].endsWith('/rc7-financial-gate.js')||
    process.argv[1].endsWith('\\rc7-financial-gate.js'))){
  void inspectRc7FinancialData()
    .then(report=>{
      console.log(JSON.stringify(report,null,2));
      if(report.classification!=='STAGE_FINANCIAL_DATA_PASS')
        process.exitCode=1;
    })
    .catch(error=>{
      console.error('RC7_FINANCIAL_DATA_GATE_FAILED',
        error instanceof Error?error.name:'unknown');
      process.exitCode=2;
    })
    .finally(async()=>{await db.$disconnect();});
}
