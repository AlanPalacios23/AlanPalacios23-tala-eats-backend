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
const timer=setInterval(()=>{void tick();},5000);
void tick();
const shutdown=async()=>{
 if(stopping)return;
 stopping=true;
 clearInterval(timer);
 if(pushTimer)clearInterval(pushTimer);
 try{await redis.del('tala:node:live:web-push:heartbeat');}catch{/* TTL expires */}
 try{await redis.del(key);}catch{/* TTL expires on outage */}
 redis.disconnect();
 await db.$disconnect();
 await pool.end();
};
process.once('SIGTERM',()=>{void shutdown().then(()=>process.exit(0));});
process.once('SIGINT',()=>{void shutdown().then(()=>process.exit(0));});
console.log('TALA_LIVE_FINANCE_WORKER_RUNNING_NO_CONNECT_PAYOUTS');
