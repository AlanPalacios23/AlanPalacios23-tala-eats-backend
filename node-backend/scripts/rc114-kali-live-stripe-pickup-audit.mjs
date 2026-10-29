#!/usr/bin/env node
/**
 * RC11.4 Stripe LIVE PICKUP read-only reconciliation:
 * production PostgreSQL + immutable local receipts + Stripe API retrieval.
 * Does NOT create payment intents, refunds, transfers or payouts.
 * Fails closed on missing data, no observed charges, partial scan,
 * remote object mismatch, unresolved reversals, and Stripe network failures.
 * Prints counts/reason codes only (no identities, amounts or secrets).
 */
import {lstatSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import Stripe from 'stripe';
import {config} from '../dist/config.js';
import {db} from '../dist/db.js';
import {auditCapturedLiveStripePickup} from '../src/finance/rc114-stripe-order-ledger-audit.mjs';
const sha=process.argv[2];
const fail=msg=>{console.log('RC114_STRIPE_AUDIT=HOLD_'+msg);process.exitCode=2;};
const asMinor=raw=>{
 const s=String(raw);
 if(!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(s))throw Error('INVALID_MONEY');
 const [a,b='']=s.split('.');return Number(BigInt(a)*100n+BigInt((b+'00').slice(0,2)));
};
async function main(){
 if(process.argv.length!==3||!/^[a-f0-9]{40}$/.test(sha??'')||
    process.getuid?.()===0||process.env.USER!=='tala-node-stage'||
    homedir()!=='/home/tala-node-stage')return fail('SERVICE_USER_OR_SHA');
 const root=resolve('..');
 if(root!==join(homedir(),'tala-node-releases',sha)||
    execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==sha)
    return fail('RELEASE_IDENTITY');
 const envPath=join(homedir(),'.config/talaeats-node-live.env');
 if(!existsSync(envPath))return fail('LIVE_ENV_ABSENT');
 const st=lstatSync(envPath);
 if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||
    (st.mode&0o777)!==0o600)return fail('LIVE_ENV_PERMISSIONS');
 const pg=new URL(config.DATABASE_URL);
 if(config.NODE_ENV!=='production'||config.PORT!==18190||
    pg.hostname!=='127.0.0.1'||pg.port!=='15445'||pg.pathname!=='/tala_node_live')
    return fail('LIVE_DB_IDENTITY');
 if(!/^(sk|rk)_live_[A-Za-z0-9]+$/.test(config.STRIPE_SECRET_KEY??'')||
    config.STRIPE_LIVE_ENABLED!=='true')
    return fail('LIVE_STRIPE_READ_CAPABILITY_MISSING');
 const where={orderType:'pickup',paymentMethod:'stripe',
  paymentStatus:{in:['paid','partially_refunded','refunded']}};
 const count=await db.marketOrder.count({where});
 if(count===0)return fail('NO_VERIFIED_LIVE_PICKUP_PAYMENTS');
 if(count>100)return fail('OVER_100_ORDERS_REQUIRES_PAGED_AUDIT');
 const orders=await db.marketOrder.findMany({where,take:100,
  orderBy:{id:'asc'},select:{
   id:true,userId:true,orderType:true,paymentMethod:true,paymentStatus:true,
   status:true,paymentProvider:true,paymentProviderId:true,
   total:true,subtotal:true,discount:true,tip:true,deliveryFee:true,
   serviceFee:true,platformCommission:true,restaurantPayout:true,
   driverEarning:true,platformRevenue:true,paymentProcessingFee:true,
   refundedAmount:true,cashCollected:true,
  }});
 if(orders.length!==count)return fail('ORDER_SAMPLE_CHANGED');
 const ids=orders.map(o=>o.id);
 const [ledger,events]=await Promise.all([
   db.stageFinancialLedgerEntry.findMany({where:{orderId:{in:ids}},
    select:{orderId:true,account:true,amount:true,currency:true,
     direction:true,kind:true,idempotencyKey:true}}),
   db.stageOrderEvent.findMany({where:{orderId:{in:ids},status:'received'},
    select:{orderId:true,status:true,metadataJson:true}}),
 ]);
 const byId=(rows)=>{const m=new Map();for(const r of rows){
  const a=m.get(r.orderId)??[];a.push(r);m.set(r.orderId,a);
 }return m;};
 const ledgers=byId(ledger),origins=byId(events);
 const provider=new Stripe(config.STRIPE_SECRET_KEY,{maxNetworkRetries:0,timeout:5000});
 let passed=0,held=0;const reasons=new Map();
 const mark=(reason)=>reasons.set(reason,(reasons.get(reason)??0)+1);
 for(const o of orders){
  try{
   const candidates=(origins.get(o.id)??[]).filter(r=>{
    try{return JSON.parse(r.metadataJson).source==='stripe_live_webhook';}
    catch{return false;}
   });
   if(candidates.length!==1){held++;mark('WEBHOOK_ORDER_EVENT_NOT_UNIQUE');continue;}
   const meta=JSON.parse(candidates[0].metadataJson);
   if(!/^evt_[A-Za-z0-9]+$/.test(meta.stripe_event_id??'')){
    held++;mark('BAD_EVENT_REFERENCE');continue;
   }
   const stored=await db.stripeWebhookEvent.findUnique({
     where:{id:meta.stripe_event_id},select:{
      id:true,type:true,status:true,stripeAccountId:true,objectId:true}});
   const audited=auditCapturedLiveStripePickup(o,ledgers.get(o.id)??[],
      stored,candidates[0]);
   if(!audited.pass){held++;for(const c of audited.findings)mark(c);continue;}
   // READ-ONLY provider confirmation: a processed local event is not sufficient.
   const [pi,remoteEvent]=await Promise.all([
     provider.paymentIntents.retrieve(o.paymentProviderId),
     provider.events.retrieve(meta.stripe_event_id),
   ]);
   if(!pi.livemode||pi.id!==o.paymentProviderId||pi.currency!=='mxn'||
      pi.status!=='succeeded'||pi.amount!==asMinor(o.total)||
      pi.amount_received!==asMinor(o.total)||
      pi.metadata?.tala_mode!=='rc8_live_pickup'||
      pi.metadata?.order_id!==String(o.id)||
      pi.metadata?.buyer_id!==String(o.userId)||
      !remoteEvent.livemode||remoteEvent.account||
      remoteEvent.type!=='payment_intent.succeeded'||
      remoteEvent.id!==stored.id||
      remoteEvent.data?.object?.id!==pi.id){
     held++;mark('REMOTE_STRIPE_CAPTURE_MISMATCH');continue;
   }
   passed++;
  }catch{held++;mark('STRIPE_OR_DATABASE_RECONCILIATION_ERROR');}
 }
 console.log('RC114_LIVE_STRIPE_PICKUP_ORDERS_SCANNED='+orders.length);
 console.log('RC114_LIVE_STRIPE_PICKUP_ORDERS_VERIFIED='+passed);
 console.log('RC114_LIVE_STRIPE_PICKUP_ORDERS_HELD='+held);
 console.log('RC114_AUDIT_REASON_CODES='+[...reasons].sort(([a],[b])=>a.localeCompare(b))
   .map(([k,v])=>k+':'+v).join(','));
 console.log('RC114_PROVIDER_OPERATIONS=GET_ONLY');
 console.log('RC114_DB_WRITES=NONE');
 console.log('RC114_WITHDRAWAL_ELIGIBILITY=NOT_PROVEN');
 if(held>0)return fail('STRIPE_LIVE_FINANCIAL_REVIEW_REQUIRED');
 console.log('RC114_STRIPE_PICKUP_AUDIT=PASS_REMOTE_READ_ONLY');
}
try{await main();}
catch{fail('DEPENDENCY_FAILURE');}
finally{await db.$disconnect();}
