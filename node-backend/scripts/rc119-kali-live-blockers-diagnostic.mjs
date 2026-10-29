#!/usr/bin/env node
/**
 * RC119: why LIVE checkout / driver / event outbox are blocked.
 * Bounded, aggregated SQL SELECT only; no owner emails, IDs or GPS logged.
 * No admin actions, payouts, orders, refunds, retries or provider mutations.
 */
import {readFileSync,existsSync,lstatSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {config} from '../dist/config.js';
import {db} from '../dist/db.js';

const sha=process.argv[2];
const names=[
 'restaurantsTotal','restaurantsVerified','restaurantsCatalogCandidates',
 'restaurantsWithActiveOwner','restaurantsOwnerConnectApproved',
 'driversAdminVerified','driversOnlineApproved','driversOnlineNotBusy',
 'driversConnectOwnerApproved','outboxStalePending','outboxStaleNeverAttempted',
 'outboxStalePreviouslyAttempted','outboxStaleOrderEvents',
 'outboxStaleOtherEvents','outboxRetryDue','outboxDeadLetter',
];
function hold(reason){
 console.log('RC119_READONLY_DIAGNOSTIC=HOLD_'+reason);
 process.exitCode=2;
}
async function main(){
 if(process.argv.length!==3||!/^[a-f0-9]{40}$/.test(sha??'')||
   process.getuid?.()===0||process.env.USER!=='tala-node-stage'||
   homedir()!=='/home/tala-node-stage')return hold('SERVICE_OR_SHA');
 const root=resolve('..'),expected=join(homedir(),'tala-node-releases',sha);
 if(root!==expected||execFileSync('git',['-C',root,'rev-parse','HEAD'],
  {encoding:'utf8'}).trim()!==sha)return hold('PINNED_RELEASE_MISMATCH');
 const envfile=join(homedir(),'.config/talaeats-node-live.env');
 if(!existsSync(envfile))return hold('ENV_MISSING');
 const stat=lstatSync(envfile);
 if(!stat.isFile()||stat.isSymbolicLink()||
    stat.uid!==process.getuid()||(stat.mode&0o777)!==0o600)
  return hold('ENV_PERMISSIONS');
 const pg=new URL(config.DATABASE_URL);
 if(config.NODE_ENV!=='production'||config.PORT!==18190||
    pg.hostname!=='127.0.0.1'||pg.port!=='15445'||
    pg.pathname!=='/tala_node_live')
  return hold('WRONG_DATABASE');
 const sql=readFileSync(new URL('./sql/rc119-live-blockers-summary.sql',
  import.meta.url),'utf8');
 if(!sql.startsWith('-- RC119 READ-ONLY operational HOLD diagnostics,')||
    /;|\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|DROP|ALTER|FOR UPDATE)\b/i
      .test(sql.replace(/^--[^\n]*\n/gm,'')))
  return hold('UNAPPROVED_SQL');
 const result=await db.$queryRawUnsafe(sql);
 if(!Array.isArray(result)||result.length!==1)
  return hold('BAD_COUNTER_QUERY');
 const counters={};
 for(const k of names){
  const value=result[0][k];
  if(typeof value!=='string'||!/^(?:0|[1-9]\d*)$/.test(value)||
     !Number.isSafeInteger(Number(value)))return hold('COUNTER_INVALID');
  counters[k]=Number(value);
  console.log('RC119_'+k.toUpperCase()+'='+value);
 }
 // The financial ledger is never inferred from the outbox status.
 console.log('RC119_CASH_DELIVERY_FLAGS='+
  ['LIVE_DELIVERY_CASH_CHECKOUT_ENABLED','LIVE_DELIVERY_CASH_DISPATCH_ENABLED',
   'LIVE_DELIVERY_CASH_RELEASE_APPROVED']
   .map(k=>config[k]).join(','));
 console.log('RC119_OLD_OUTBOX_EVENTS_ARE_NOT_AUTOMATICALLY_DELETED=YES');
 console.log('RC119_NO_ACCOUNT_OR_BANK_DETAILS_EXPOSED=YES');
 console.log('RC119_DATABASE_AND_STRIPE_WRITES=NONE');
 console.log('RC119_COMMERCIAL_GO=NOT_AUTHORIZED');
 console.log('RC119_READONLY_DIAGNOSTIC=PASS_COUNTS_ONLY');
}
try{await main();}catch{hold('QUERY_OR_DEPENDENCY_FAILURE');}
finally{await db.$disconnect();}
