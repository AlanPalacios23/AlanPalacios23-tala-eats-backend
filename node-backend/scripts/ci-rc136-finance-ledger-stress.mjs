/**
 * RC13.6 financial-load integration. Synthetic 400 purchase-value journals
 * covering four payment modes. GITHUB ACTIONS + isolated PG15 ONLY.
 * Journal values are illustrative bookkeeping; no LIVE purchases or Stripe.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {writeFile,appendFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {recordFinanceJournal} from '../dist/finance/journal-repository-v2.js';

const url=process.env.DATABASE_URL??'';
let safe=false;
try{
 const u=new URL(url);
 safe=process.env.GITHUB_ACTIONS==='true'&&
  process.env.NODE_ENV==='staging'&&
  u.hostname==='127.0.0.1'&&u.port==='15435'&&
  u.pathname==='/tala_node_stage'&&
  process.env.RC136_FINANCE_STRESS==='true'&&
  process.env.STRIPE_LIVE_ENABLED==='false'&&
  process.env.STRIPE_FINANCIAL_WRITES_ENABLED==='false'&&
  process.env.STRIPE_CONNECT_TRANSFERS_ENABLED==='false'&&
  !/_(?:live)_/.test(process.env.STRIPE_SECRET_KEY??'');
}catch{}
if(!safe)throw Error('RC136_DISPOSABLE_GITHUB_CI_ONLY');

const pool=new Pool({connectionString:url,max:16,connectionTimeoutMillis:5000,
 idleTimeoutMillis:10000,statement_timeout:12000});
const runId=randomUUID().replaceAll('-','');
const modes=['pickup_card','pickup_cash','delivery_card','delivery_cash'];
const asset={
 pickup_card:'asset.r136_stripe_'+runId,
 pickup_cash:'asset.r136_shopcash_'+runId,
 delivery_card:'asset.r136_stripe_'+runId,
 delivery_cash:'asset.r136_couriercash_'+runId
};
const payee='liability.r136_merchant_'+runId;
const driver='liability.r136_driver_'+runId;
const revenue='revenue.r136_platform_'+runId;
const observed=[],errors=[];
const out='/tmp/rc136-finance-stress.json';
let completed=0,replays=0,conflictChecks=0,report=null;
const pct=(xs,p)=>{
 if(xs.length===0)return null;
 const copy=[...xs].sort((a,b)=>a-b);
 return Number(copy[Math.max(0,Math.ceil(copy.length*p)-1)].toFixed(1));
};
const jobs=Array.from({length:400},(_,i)=>({i,mode:modes[i%4]}));
const event=({i,mode})=>{
 const delivery=mode.startsWith('delivery');
 const cents=delivery?25300n:21400n;
 const lines=[
  {accountKey:asset[mode],side:'debit',amountMinor:cents},
  {accountKey:payee,side:'credit',amountMinor:17000n},
  ...(delivery?[{accountKey:driver,side:'credit',amountMinor:3200n}]:[]),
  {accountKey:revenue,side:'credit',amountMinor:delivery?5100n:4400n},
 ];
 return {eventKey:'rc136.order.'+runId+':'+i,
  sourceType:'order',sourceRef:'synthetic:'+runId+':'+i,
  description:'CI ONLY synthetic merchant and courier entitlement',
  lines};
};
async function concurrent(items,parallel,action){
 let n=0;
 await Promise.all(Array.from({length:parallel},async()=>{
  for(;;){
   const index=n++;if(index>=items.length)break;
   const started=performance.now();
   try{await action(items[index]);}
   catch(e){errors.push({job:index,error:e instanceof Error?e.message:'UNKNOWN'});
    throw e;}
   finally{observed.push(performance.now()-started);}
  }
 }));
}
const start=performance.now();
try{
 const accounts=[...new Set(Object.values(asset)),payee,driver,revenue];
 for(const key of accounts){
  const category=key.startsWith('asset.')?'asset':key.startsWith('liability.')?'liability':'revenue';
  await pool.query(
   'INSERT INTO finance_accounts_v2(account_key,owner_kind,category,currency) VALUES($1,$2,$3,$4)',
   [key,'platform',category,'mxn']);
 }
 await concurrent(jobs,20,async j=>{
  const x=await recordFinanceJournal(pool,event(j));
  assert.equal(x.replayed,false);
  completed++;
 });
 assert.equal(completed,400,'Missing committed synthetic journals');
 // Same 80 keys retried concurrently: all must replay the SAME journal.
 const duplicates=jobs.slice(0,80).flatMap(x=>[x,x]);
 await concurrent(duplicates,20,async j=>{
  const x=await recordFinanceJournal(pool,event(j));
  assert.equal(x.replayed,true);
  replays++;
 });
 assert.equal(replays,160);
 // Conflicting idempotency key: prevent changed amounts from posting.
 for(const j of jobs.slice(0,20)){
  const changed=event(j);
  changed.lines[0]={...changed.lines[0],amountMinor:changed.lines[0].amountMinor+1n};
  changed.lines[1]={...changed.lines[1],amountMinor:changed.lines[1].amountMinor+1n};
  await assert.rejects(recordFinanceJournal(pool,changed),
   /FINANCE_DUPLICATE_EVENT_DIFFERENT_CONTENT/);
  conflictChecks++;
 }
 // The DB, not just JavaScript, is the source of conservation truth.
 const stats=await pool.query(
  'SELECT j.id::text, j.status,COUNT(p.id)::int AS entries,'+
  'COALESCE(SUM(p.debit_minor),0)::text AS debit,'+
  'COALESCE(SUM(p.credit_minor),0)::text AS credit '+
  'FROM finance_journals_v2 j LEFT JOIN finance_postings_v2 p ON p.journal_id=j.id '+
  'WHERE j.event_key LIKE $1 GROUP BY j.id,j.status',
  ['rc136.order.'+runId+':%']);
 assert.equal(stats.rows.length,400,'Journal count not exactly 400');
 for(const item of stats.rows){
  assert.equal(item.status,'posted');
  assert.equal(item.debit,item.credit,'UNBALANCED_FINANCE_JOURNAL_'+item.id);
  assert.ok(item.entries===3||item.entries===4);
 }
 const credited=stats.rows.reduce((s,x)=>s+BigInt(x.credit),0n);
 assert.equal(credited,100n*21400n*2n+100n*25300n*2n);
 assert.equal(errors.length,0);
 const runtime=performance.now()-start;
 const p95=pct(observed,.95);
 assert.ok(p95!==null&&p95<6000,'FINANCE_STRESS_P95_EXCEEDED_6000MS');
 assert.ok(runtime<180000,'FINANCE_STRESS_TOTAL_EXCEEDED_3MIN');
 report={scenario:'RC13.6 400 synthetic journals covering four modes',
  runId,environment:'isolated GitHub Actions PG15',real_charges:0,
  orders:400,order_modes:Object.fromEntries(modes.map(m=>[m,100])),
  committed:completed,replays,conflict_rejections:conflictChecks,
  unbalanced:0,duplicate_entries:0,entries_verified:stats.rows.length,
  debits_and_credits_minor:credited.toString(),
  timings_ms:{p50:pct(observed,.5),p95,p99:pct(observed,.99),
   max:pct(observed,1),total:Number(runtime.toFixed(1))},
  status:'PASS',production_capacity_proven:false};
 console.log('RC136_FINANCE_STRESS_PASS='+JSON.stringify(report));
}catch(e){
 report={status:'FAIL',reason:e instanceof Error?e.message:'UNKNOWN',
  committed:completed,replays,conflict_checks:conflictChecks,errors:errors.slice(0,8),
  real_charges:0,environment:'isolated GitHub Actions PG15'};
 console.error('RC136_FINANCE_STRESS_FAIL='+JSON.stringify(report));
 process.exitCode=1;
}finally{
 await writeFile(out,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 if(process.env.GITHUB_STEP_SUMMARY){
  await appendFile(process.env.GITHUB_STEP_SUMMARY,
  '## RC13.6 · Estres financiero aislado\n'+
  'Resultado: **'+report.status+'** · diarios: '+completed+
  ' · reintentos: '+replays+' · conflictos: '+conflictChecks+
  ' · p95: '+(report.timings_ms?.p95??'N/A')+' ms.\n'+
  'No usa Stripe LIVE. No demuestra capacidad del Kali productivo.\n');
 }
 await pool.end();
}
