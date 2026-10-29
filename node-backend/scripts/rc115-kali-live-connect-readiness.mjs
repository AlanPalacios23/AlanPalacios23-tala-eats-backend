#!/usr/bin/env node
/**
 * RC11.5 owner-mapped recipient check (LIVE, READ-ONLY).
 * Queries existing production PostgreSQL mappings and Stripe accounts/balances.
 * This CANNOT send transfers/payouts, reconcile liabilities, or verify
 * delivery into a bank account. No IDs, names, balances or secrets in logs.
 */
import {existsSync,lstatSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import Stripe from 'stripe';
import {config} from '../dist/config.js';
import {db} from '../dist/db.js';
import {classifyLiveConnectRecipient}
 from '../src/finance/rc115-connect-readiness.mjs';
const sha=process.argv[2];
const hold=code=>{console.log('RC115_CONNECT_READINESS=HOLD_'+code);process.exitCode=2;};
async function main(){
 if(process.argv.length!==3||!/^[0-9a-f]{40}$/.test(sha??'')||
    process.getuid?.()===0||process.env.USER!=='tala-node-stage'||
    homedir()!=='/home/tala-node-stage')return hold('SERVICE_OR_SHA');
 const root=resolve('..'),expected=join(homedir(),'tala-node-releases',sha);
 if(root!==expected||
    execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==sha)
   return hold('RELEASE_IDENTITY');
 const envPath=join(homedir(),'.config/talaeats-node-live.env');
 if(!existsSync(envPath))return hold('LIVE_ENV_MISSING');
 const st=lstatSync(envPath);
 if(!st.isFile()||st.isSymbolicLink()||
    st.uid!==process.getuid()||(st.mode&0o777)!==0o600)
   return hold('LIVE_ENV_PERMISSIONS');
 const pg=new URL(config.DATABASE_URL);
 if(config.NODE_ENV!=='production'||config.PORT!==18190||
    pg.hostname!=='127.0.0.1'||pg.port!=='15445'||
    pg.pathname!=='/tala_node_live'||
    !/^(sk|rk)_live_[A-Za-z0-9]+$/.test(config.STRIPE_SECRET_KEY??''))
   return hold('PRODUCTION_ACCOUNT_IDENTITY');
 // For an audit, never depend on payout execution being enabled.
 const count=await db.merchantConnectAccount.count();
 if(count===0)return hold('NO_DURABLE_CONNECT_MAPPINGS');
 if(count>25)return hold('CONNECT_MAPS_REQUIRE_PAGINATION');
 const mappings=await db.merchantConnectAccount.findMany({
  select:{merchantId:true,stripeAccountId:true,
   chargesEnabled:true,payoutsEnabled:true},
  take:25,orderBy:{merchantId:'asc'},
 });
 if(mappings.length!==count)return hold('CONNECT_MAPPING_SET_CHANGED');
 const stripe=new Stripe(config.STRIPE_SECRET_KEY,{maxNetworkRetries:0,timeout:5000});
 let ready=0,held=0;const reasons=new Map();
 const mark=k=>reasons.set(k,(reasons.get(k)??0)+1);
 for(const m of mappings){
  try{
   if(!/^acct_[A-Za-z0-9]+$/.test(m.stripeAccountId)){
    held++;mark('INVALID_CONNECTED_ACCOUNT_REFERENCE');continue;
   }
   const [account,balance]=await Promise.all([
    stripe.accounts.retrieve(m.stripeAccountId),
    stripe.balance.retrieve({stripeAccount:m.stripeAccountId}),
   ]);
   const report=classifyLiveConnectRecipient(m,account,balance);
   if(report.readyForFurtherFinancialReconciliation)ready++;
   else {held++;for(const code of report.reasons)mark(code);}
  }catch{held++;mark('STRIPE_CONNECT_GET_OR_DB_FAILED');}
 }
 console.log('RC115_DURABLE_CONNECT_MAPPINGS='+mappings.length);
 console.log('RC115_MAPPED_ACCOUNTS_REMOTE_READY='+ready);
 console.log('RC115_MAPPED_ACCOUNTS_HELD='+held);
 console.log('RC115_FAILURE_CODES='+[...reasons].sort(([a],[b])=>a.localeCompare(b))
   .map(([c,n])=>c+':'+n).join(','));
 console.log('RC115_REMOTE_OPERATIONS=GET_ONLY');
 console.log('RC115_DATABASE_WRITES=NONE');
 console.log('RC115_DRIVER_PAYEE_COVERAGE=NOT_VERIFIED');
 console.log('RC115_LEDGER_WITHDRAWABLE_BALANCES=NOT_VERIFIED');
 console.log('RC115_TRANSFER_AND_PAYOUT_EXECUTION=DISABLED_BY_THIS_AUDIT');
 if(held)return hold('CONNECTED_ACCOUNT_CAPABILITY_REVIEW_REQUIRED');
 console.log('RC115_CONNECT_CAPABILITIES=PASS_READ_ONLY_NOT_PAYOUT_APPROVAL');
}
try{await main();}
catch{hold('DEPENDENCY_FAILURE');}
finally{await db.$disconnect();}
