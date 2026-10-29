#!/usr/bin/env node
/**
 * RC11.6 read-only financial recovery audit for a pinned LIVE Node release.
 * Never closes cases, refunds, requeues events or releases money.
 * Only counts/statuses are printed. Does not self-certify backup or alerts.
 */
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {config} from '../dist/config.js';
import {db} from '../dist/db.js';
import {assessLiveRecoveryCounters,recoveryCounterKeys}
 from '../src/finance/rc116-recovery-readiness.mjs';
const sha=process.argv[2];
const fail=code=>{console.log('RC116_RECOVERY_AUDIT=HOLD_'+code);process.exitCode=2;};
async function run(){
 if(process.argv.length!==3||!/^[a-f0-9]{40}$/.test(sha??'')||
    process.getuid?.()===0||process.env.USER!=='tala-node-stage'||
    homedir()!=='/home/tala-node-stage')return fail('PINNED_SERVICE_REQUIRED');
 const root=resolve('..');
 if(root!==join(homedir(),'tala-node-releases',sha)||
    execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==sha)
   return fail('RELEASE_SHA_MISMATCH');
 const env=join(homedir(),'.config/talaeats-node-live.env');
 if(!existsSync(env))return fail('LIVE_ENV_MISSING');
 const stat=lstatSync(env);
 if(!stat.isFile()||stat.isSymbolicLink()||
    stat.uid!==process.getuid()||(stat.mode&0o777)!==0o600)
   return fail('LIVE_ENV_PERMISSIONS');
 const dburl=new URL(config.DATABASE_URL);
 if(config.NODE_ENV!=='production'||config.PORT!==18190||
    dburl.hostname!=='127.0.0.1'||dburl.port!=='15445'||
    dburl.pathname!=='/tala_node_live')
   return fail('NOT_ISOLATED_LIVE_DATABASE');
 const sql=readFileSync(new URL('./sql/rc116-live-financial-recovery.sql',import.meta.url),'utf8');
 if(!sql.trimStart().startsWith('-- RC11.6 LIVE recovery counters, read only.')||
    sql.includes(';'))return fail('UNAPPROVED_AUDIT_SQL');
 const rows=await db.$queryRawUnsafe(sql);
 if(!Array.isArray(rows)||rows.length!==1)return fail('INVALID_FINANCIAL_QUERY');
 const raw=rows[0],counters={};
 for(const k of recoveryCounterKeys){
  const value=raw[k];
  if(typeof value!=='string'||!/^(?:0|[1-9][0-9]*)$/.test(value))
    return fail('INVALID_COUNT_'+k.toUpperCase());
  const n=Number(value);
  if(!Number.isSafeInteger(n))return fail('COUNT_OVERFLOW');
  counters[k]=n;
 }
 if(!['0','1'].includes(raw.hasObservedRealOrders))
   return fail('REAL_ORDER_COUNT_INVALID');
 const report=assessLiveRecoveryCounters(counters,{
  hasObservedRealOrders:raw.hasObservedRealOrders==='1',
  // Independent external proofs cannot be self-certified by a SQL query.
  backupRestoreProven:false,alertDeliveryProven:false,
 });
 for(const key of recoveryCounterKeys)
  console.log('RC116_'+key.toUpperCase()+'='+counters[key]);
 console.log('RC116_READONLY_FINANCIAL_BACKLOG_CLEAR='+
  (recoveryCounterKeys.every(k=>counters[k]===0)?'YES':'NO'));
 console.log('RC116_DB_WRITES=NONE');
 console.log('RC116_STRIPE_WRITES=NONE');
 console.log('RC116_BACKUP_RESTORE_PROVEN=NO');
 console.log('RC116_ALERT_DELIVERY_PROVEN=NO');
 console.log('RC116_REFUNDS_AUTO_RESOLVED=NO');
 console.log('RC116_FINDINGS='+report.reasons.join(','));
 if(!report.pass)return fail('FINANCIAL_RECOVERY_OR_EXTERNAL_EVIDENCE');
 console.log('RC116_RECOVERY_AUDIT=PASS_READONLY_NOT_LAUNCH_AUTHORIZATION');
}
try{await run();}catch{fail('DEPENDENCY_OR_QUERY_FAILURE');}
finally{await db.$disconnect();}
