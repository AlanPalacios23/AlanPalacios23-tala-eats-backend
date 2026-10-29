#!/usr/bin/env node
/**
 * RC11.4 — Read-only LIVE cash delivery audit (no Stripe mutation, no payouts).
 * Only aggregate counts are printed. Absence of audited real orders = HOLD.
 * Call under the pinned production release, with Node 24 --env-file.
 */
import {existsSync,lstatSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {config} from '../dist/config.js';
import {db} from '../dist/db.js';
import {isLiveCashCheckoutProvenance}
 from '../dist/marketplace/live-cash-delivery-policy.js';
import {auditDeliveredLiveCashOrder}
 from '../src/finance/rc114-cash-order-ledger-audit.mjs';

const sha=process.argv[2],envFile=join(homedir(),'.config/talaeats-node-live.env');
const abort = code => {console.log('RC114_AUDIT=HOLD_'+code);process.exitCode=2;};
async function run(){
 if(process.argv.length!==3||!/^[a-f0-9]{40}$/.test(sha??'')||
    process.getuid?.()===0||process.env.USER!=='tala-node-stage'||
    homedir()!=='/home/tala-node-stage')return abort('SERVICE_OR_SHA');
 const root=resolve('..');
 if(root!==join(homedir(),'tala-node-releases',sha))return abort('PINNED_RELEASE_PATH');
 if(execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==sha)
   return abort('HEAD_CHANGED');
 if(!existsSync(envFile))return abort('ENV_FILE_MISSING');
 const st=lstatSync(envFile);
 if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||
    (st.mode&0o777)!==0o600)return abort('ENV_FILE_PERMISSIONS');
 const url=new URL(config.DATABASE_URL);
 if(config.NODE_ENV!=='production'||url.hostname!=='127.0.0.1'||
    url.port!=='15445'||url.pathname!=='/tala_node_live'||
    config.PORT!==18190)return abort('NOT_PRODUCTION_DATABASE');
 // Pin audit to only the valid cash-at-door financial contract.
 if(config.COMMERCIAL_PRICING_V162_ENABLED==='true'||
    config.MERCHANT_MANAGED_DELIVERY==='true')return abort('PRICING_POLICY_CHANGED');
 const where={orderType:'delivery',paymentMethod:'cash',status:'delivered'};
 const count=await db.marketOrder.count({where});
 // A bounded window must never be reported as exhaustive.
 if(count>1000)return abort('MORE_THAN_1000_DELIVERED_REQUIRES_PAGINATED_AUDIT');
 const orders=await db.marketOrder.findMany({where,take:1000,
    orderBy:{id:'asc'},select:{
      id:true,driverId:true,orderType:true,paymentMethod:true,status:true,
      paymentStatus:true,total:true,subtotal:true,discount:true,
      deliveryFee:true,tip:true,serviceFee:true,platformCommission:true,
      restaurantPayout:true,driverEarning:true,platformRevenue:true,
      cashCollected:true,refundedAmount:true,
      paymentProcessingFee:true,contributionMargin:true,
    }});
 if(orders.length!==count)return abort('CONCURRENT_ORDER_SET_CHANGED');
 const ids=orders.map(o=>o.id);
 if(!ids.length){
   console.log('RC114_VERIFIED_LIVE_CASH_DELIVERIES=0');
   return abort('NO_REAL_COMPLETED_ORDERS');
 }
 const [events,ledgers,proofs]=await Promise.all([
   db.stageOrderEvent.findMany({where:{orderId:{in:ids},status:'received'},
      orderBy:{id:'asc'},select:{orderId:true,metadataJson:true}}),
   db.stageFinancialLedgerEntry.findMany({where:{orderId:{in:ids}},
      select:{orderId:true,kind:true,account:true,direction:true,
        amount:true,currency:true,idempotencyKey:true}}),
   db.stageDeliveryProof.findMany({where:{orderId:{in:ids}},
      select:{orderId:true,driverId:true,pinVerified:true}}),
 ]);
 const byOrder=(rows)=>{const map=new Map();for(const row of rows){
   const bucket=map.get(row.orderId)??[];bucket.push(row);map.set(row.orderId,bucket);
 }return map;};
 const eventBy=byOrder(events),ledgerBy=byOrder(ledgers),proofBy=byOrder(proofs);
 let passed=0,held=0,missingOrigin=0;
 const reasons=new Map();
 for(const o of orders){
   const origins=eventBy.get(o.id)??[];
   const verified=origins.length===1&&
     isLiveCashCheckoutProvenance(origins[0].metadataJson);
   if(!verified)missingOrigin++;
   const proofsFor=proofBy.get(o.id)??[];
   const report=auditDeliveredLiveCashOrder(o,ledgerBy.get(o.id)??[],
     proofsFor.length===1?proofsFor[0]:null);
   const failures=[...report.findings,...(!verified?['LIVE_CHECKOUT_ORIGIN_MISSING']:[]),
      ...(proofsFor.length!==1?['PIN_PROOF_COUNT_INVALID']:[])];
   if(failures.length){held++;for(const code of new Set(failures))
     reasons.set(code,(reasons.get(code)??0)+1);
   }else passed++;
 }
 console.log('RC114_DELIVERED_CASH_ORDERS_SCANNED='+orders.length);
 console.log('RC114_DELIVERED_CASH_ORDERS_VALID='+passed);
 console.log('RC114_DELIVERED_CASH_ORDERS_HELD='+held);
 console.log('RC114_MISSING_CHECKOUT_ORIGIN_COUNT='+missingOrigin);
 console.log('RC114_FAILURE_CODES='+[...reasons].sort(([a],[b])=>a.localeCompare(b))
   .map(([code,n])=>code+':'+n).join(','));
 console.log('RC114_DB_WRITES=NONE');
 console.log('RC114_PROVIDER_WRITES=NONE');
 console.log('RC114_WITHDRAWALS_AUTHORIZED=NO');
 if(held)return abort('LEDGER_MISMATCH_REQUIRES_REVIEW');
 console.log('RC114_CASH_DELIVERY_FINANCIAL_AUDIT=PASS_READ_ONLY');
}
try{await run();}
catch{abort('DEPENDENCY_OR_QUERY_FAILURE');}
finally{await db.$disconnect();}
