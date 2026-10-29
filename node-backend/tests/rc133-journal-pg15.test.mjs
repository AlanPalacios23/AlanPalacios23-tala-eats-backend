/** CI-only PostgreSQL 15 integration proof. NEVER run against LIVE. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {recordFinanceJournal} from '../dist/finance/journal-repository-v2.js';

const enabled=process.env.RC133_FINANCE_DB_TEST==='true';
const dbUrl=process.env.DATABASE_URL??'';
let safe=false;
try{
 const u=new URL(dbUrl);
 safe=enabled&&process.env.NODE_ENV==='staging'&&
  u.hostname==='127.0.0.1'&&u.port==='15435'&&
  u.pathname==='/tala_node_stage';
}catch{}
test('RC13.3 integration: safe PG15 ledger writes, replay, balance and immutability',
 {skip:!safe},async()=>{
 const pool=new Pool({connectionString:dbUrl,max:4,connectionTimeoutMillis:5000});
 const tag=randomUUID().replaceAll('-','');
 const asset='asset.rc133_'+tag;
 const shop='liability.rc133_shop_'+tag;
 const driver='liability.rc133_driver_'+tag;
 const platform='revenue.rc133_platform_'+tag;
 try{
  for(const [key,cat] of [[asset,'asset'],[shop,'liability'],
    [driver,'liability'],[platform,'revenue']]){
   await pool.query(
    'INSERT INTO finance_accounts_v2(account_key,owner_kind,category,currency) VALUES($1,$2,$3,$4)',
    [key,'platform',cat,'mxn']);
  }
  const event={
   eventKey:'rc133.captured:'+tag,sourceType:'stripe_event',
   sourceRef:'order:'+tag,description:'CI only simulated source bookkeeping',
   lines:[
    {accountKey:asset,side:'debit',amountMinor:25300n},
    {accountKey:shop,side:'credit',amountMinor:17000n},
    {accountKey:driver,side:'credit',amountMinor:3200n},
    {accountKey:platform,side:'credit',amountMinor:5100n},
   ],
  };
  // Same event may arrive simultaneously on API and worker.
  const results=await Promise.all([
   recordFinanceJournal(pool,event),
   recordFinanceJournal(pool,event),
  ]);
  assert.equal(results[0].journalId,results[1].journalId);
  assert.equal(results.filter(x=>x.replayed).length,1);
  const journal=results[0].journalId;
  const totals=await pool.query(
   'SELECT COUNT(*)::int AS lines,SUM(debit_minor)::text AS debits,SUM(credit_minor)::text AS credits FROM finance_postings_v2 WHERE journal_id=$1',
   [journal]);
  assert.equal(totals.rows[0].lines,4);
  assert.equal(totals.rows[0].debits,'25300');
  assert.equal(totals.rows[0].credits,'25300');
  await assert.rejects(
   recordFinanceJournal(pool,{...event,lines:[
    {...event.lines[0],amountMinor:25301n},
    {...event.lines[1],amountMinor:17001n},
    ...event.lines.slice(2),
   ]}),/FINANCE_DUPLICATE_EVENT_DIFFERENT_CONTENT/
  );
  await assert.rejects(pool.query(
   'UPDATE finance_postings_v2 SET credit_minor=credit_minor+1 WHERE journal_id=$1 AND credit_minor>0',
   [journal]),/FINANCE_V2_IMMUTABLE_UPDATE/);
  await assert.rejects(pool.query(
   'DELETE FROM finance_journals_v2 WHERE id=$1',[journal]),
   /FINANCE_V2_IMMUTABLE_DELETE/);
  const a=await pool.query('SELECT id FROM finance_accounts_v2 WHERE account_key=$1',[asset]);
  await assert.rejects(pool.query(
   'INSERT INTO finance_postings_v2(journal_id,line_no,account_id,debit_minor,credit_minor) VALUES($1,5,$2,1,0)',
   [journal,a.rows[0].id]),/FINANCE_V2_JOURNAL_SEALED/);

  // Raw SQL cannot bypass balance constraints by omitting the application.
  const client=await pool.connect();
  let tx=false;
  try{
   await client.query('BEGIN');tx=true;
   const j=await client.query(
    "INSERT INTO finance_journals_v2(event_key,fingerprint,source_type,source_ref,description,status) VALUES($1,$2,'adjustment',$3,$4,'building') RETURNING id",
    ['rc133.unbalanced:'+tag,'a'.repeat(64),'test:'+tag,
     'CI deliberately mismatched cents']);
   await client.query(
    'INSERT INTO finance_postings_v2(journal_id,line_no,account_id,debit_minor,credit_minor) VALUES($1,1,$2,100,0)',
    [j.rows[0].id,a.rows[0].id]);
   const b=await pool.query(
    'SELECT id FROM finance_accounts_v2 WHERE account_key=$1',[shop]);
   await client.query(
    'INSERT INTO finance_postings_v2(journal_id,line_no,account_id,debit_minor,credit_minor) VALUES($1,2,$2,0,99)',
    [j.rows[0].id,b.rows[0].id]);
   await client.query(
    "UPDATE finance_journals_v2 SET status='posted' WHERE id=$1",
    [j.rows[0].id]);
   await assert.rejects(client.query('COMMIT'),/FINANCE_V2_UNBALANCED/);
   tx=false;
  }finally{
   if(tx)await client.query('ROLLBACK').catch(()=>{});
   client.release();
  }
 }finally{
  await pool.end();
 }
});
