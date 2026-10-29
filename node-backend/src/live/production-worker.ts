/**
 * Native PM2 LIVE worker for the EXISTING two-process Tala Eats runtime.
 * No Docker, no second public API. Processes durable signed Stripe events
 * in dedicated production PostgreSQL; releases NO merchant transfers.
 */
import {config} from '../config.js';
import {buildLiveRuntimeDependencies} from './runtime-dependencies.js';
import {rc8WorkerIteration} from './worker-runner.js';
import {drainTreasuryConnectEvents} from './treasury-connect-webhook.js';
import {scanUnknownTreasuryPayouts} from './treasury-unknown-recovery.js';
import {deliverWebPushIteration,webPushConfigured} from '../operational/web-push.js';
import {db} from '../db.js';
import {deliverAuthMailBatch} from '../email.js';
import {liveDispatchReleased} from '../marketplace/live-delivery-payment.js';
import {liveCashDeliveryReleased} from '../marketplace/live-cash-delivery.js';
import {sweepLiveDeliveryReady} from '../marketplace/live-delivery-dispatch.js';

if(config.NODE_ENV!=='production')throw Error('LIVE_WORKER_ENV_REQUIRED');
const {settings,pool,redis,stripe}=buildLiveRuntimeDependencies();
const key='tala:node:live:worker:heartbeat';
let busy=false,stopping=false;
const tick=async()=>{
 if(stopping||busy)return;
 busy=true;
 try{
   // Financial data and server invoice/payouts remain on manual review
   // after exceptional chargeback/refund situations.
   const report=await rc8WorkerIteration(stripe,pool,settings,20);
   if(config.TREASURY_CONNECT_WEBHOOK_INGEST_ENABLED==='true'){
     const treasury=await drainTreasuryConnectEvents(pool,stripe,10);
     if(treasury.held)console.error('TREASURY_CONNECT_SIGNED_EVENT_REVIEW_REQUIRED');
     // Read-only provider recovery of ambiguous payout network timeouts.
     // Does not submit another payout and cannot post a bank-paid ledger.
     const recovered=await scanUnknownTreasuryPayouts(pool,stripe,1);
     if(recovered.held)console.error('TREASURY_UNKNOWN_BANK_PAYOUT_REVIEW_REQUIRED');
   }
   if(report.held>0||report.suspectPaidOrders>0||
      report.pendingRefundOrDisputeEvents>0)
     console.error('LIVE_FINANCIAL_MANUAL_REVIEW_REQUIRED');
   await redis.set(key,'online','EX',45);
 }catch{
   console.error('LIVE_FINANCE_WORKER_DEPENDENCY_OR_RECONCILIATION_HOLD');
 }finally{busy=false;}
};
// Recovery mail is independently opt-in. A mail provider outage cannot block
// Stripe processing or prevent the finance worker heartbeat.
let recoveryMailBusy=false;
async function recoveryMailTick(){
 if(stopping||recoveryMailBusy||config.LIVE_AUTH_EMAIL_DELIVERY_MODE!=='resend')return;
 recoveryMailBusy=true;
 try{await deliverAuthMailBatch();}
 catch(err){console.error('LIVE_AUTH_MAIL_DELIVERY_HOLD',
  err instanceof Error?err.name:'unknown');}
 finally{recoveryMailBusy=false;}
}
const mailTimer=config.LIVE_AUTH_EMAIL_DELIVERY_MODE==='resend'
 ?setInterval(()=>{void recoveryMailTick();},15000):null;
if(mailTimer)void recoveryMailTick();
// Web Push is opt-in, independent of Stripe reconciliation and LIVE finances.
let pushBusy=false;
async function pushTick(){
 if(pushBusy||stopping||!webPushConfigured())return;
 pushBusy=true;
 try{
  await deliverWebPushIteration(25);
  await redis.set('tala:node:live:web-push:heartbeat','ready','EX',45);
 }catch(err){
  console.error('LIVE_WEB_PUSH_WORKER_HOLD',err instanceof Error?err.name:'unknown');
 }finally{pushBusy=false;}
}
const pushTimer=webPushConfigured()?setInterval(()=>{void pushTick();},15000):null;
if(pushTimer)void pushTick();
// Independent bounded READY recovery, never coupled to Stripe receipt writes.
let readyBusy=false;
async function readyTick(){
 if(stopping||readyBusy||(!liveDispatchReleased()&&!liveCashDeliveryReleased()))return;
 readyBusy=true;
 try{
  const result=await sweepLiveDeliveryReady();
  if(result.held>0)console.error('LIVE_DELIVERY_READY_PENDING_OPERATOR_MONITOR');
  await redis.set('tala:node:live:dispatch:sweep:ok','1','EX',60);
 }catch(err){console.error('LIVE_DELIVERY_DISPATCH_RECOVERY_HOLD',
     err instanceof Error?err.name:'unknown');}
 finally{readyBusy=false;}
}
const readyTimer=setInterval(()=>{void readyTick();},15000);
void readyTick();
const timer=setInterval(()=>{void tick();},5000);
void tick();
const shutdown=async()=>{
 if(stopping)return;
 stopping=true;
 clearInterval(timer);
 clearInterval(readyTimer);
 if(pushTimer)clearInterval(pushTimer);
 if(mailTimer)clearInterval(mailTimer);
 try{await redis.del('tala:node:live:web-push:heartbeat');}catch{/* TTL expires */}
 try{await redis.del(key);}catch{/* TTL expires on outage */}
 redis.disconnect();
 await db.$disconnect();
 await pool.end();
};
process.once('SIGTERM',()=>{void shutdown().then(()=>process.exit(0));});
process.once('SIGINT',()=>{void shutdown().then(()=>process.exit(0));});
console.log('TALA_LIVE_FINANCE_WORKER_RUNNING_NO_CONNECT_PAYOUTS');
