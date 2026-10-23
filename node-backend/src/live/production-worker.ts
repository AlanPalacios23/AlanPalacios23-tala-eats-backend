/**
 * Native PM2 LIVE worker for the EXISTING two-process Tala Eats runtime.
 * No Docker, no second public API. Processes durable signed Stripe events
 * in dedicated production PostgreSQL; releases NO merchant transfers.
 */
import {config} from '../config.js';
import {buildLiveRuntimeDependencies} from './runtime-dependencies.js';
import {rc8WorkerIteration} from './worker-runner.js';

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
   if(report.held>0||report.suspectPaidOrders>0||
      report.pendingRefundOrDisputeEvents>0)
     console.error('LIVE_FINANCIAL_MANUAL_REVIEW_REQUIRED');
   await redis.set(key,'online','EX',45);
 }catch{
   console.error('LIVE_FINANCE_WORKER_DEPENDENCY_OR_RECONCILIATION_HOLD');
 }finally{busy=false;}
};
const timer=setInterval(()=>{void tick();},5000);
void tick();
const shutdown=async()=>{
 if(stopping)return;
 stopping=true;
 clearInterval(timer);
 try{await redis.del(key);}catch{/* TTL expires on outage */}
 redis.disconnect();
 await pool.end();
};
process.once('SIGTERM',()=>{void shutdown().then(()=>process.exit(0));});
process.once('SIGINT',()=>{void shutdown().then(()=>process.exit(0));});
console.log('TALA_LIVE_FINANCE_WORKER_RUNNING_NO_CONNECT_PAYOUTS');
