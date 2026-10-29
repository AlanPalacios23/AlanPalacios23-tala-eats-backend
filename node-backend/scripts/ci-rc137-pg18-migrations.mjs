/** RC13.7 — PostgreSQL 18 isolated migration and finance invariant validation.
 * Never run against a live DB: hard-gated to GitHub Actions and disposable PG18.
 */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import pg from 'pg';

const u=new URL(process.env.DATABASE_URL??'');
assert.equal(process.env.GITHUB_ACTIONS,'true','GITHUB_CI_ONLY');
assert.equal(process.env.NODE_ENV,'staging','STAGING_ONLY');
assert.equal(u.hostname,'127.0.0.1','LOOPBACK_ONLY');
assert.equal(u.port,'15455','PG18_DISPOSABLE_PORT_ONLY');
assert.equal(u.pathname,'/tala_rc137_pg18','DISPOSABLE_DB_ONLY');
assert.equal(u.username,'rc137_ci','DISPOSABLE_DB_ROLE_ONLY');
for(const key of ['STRIPE_LIVE_ENABLED','STRIPE_FINANCIAL_WRITES_ENABLED',
 'STRIPE_CONNECT_TRANSFERS_ENABLED','STRIPE_REFUNDS_ENABLED']){
 assert.equal(process.env[key],'false',key+'_MUST_BE_FALSE');
}
const db=new pg.Client({connectionString:process.env.DATABASE_URL,
  connectionTimeoutMillis:5000,statement_timeout:15000});
const expected=['20261029_rc133_finance_general_ledger_v2',
                '20261029_rc135_cash_handoff_v2'];
const unique=randomUUID().replaceAll('-','').slice(0,16);
const sha=x=>createHash('sha256').update(x).digest('hex');
const q=(sql,params=[])=>db.query(sql,params);
try{
 await db.connect();
 const pgVersion=Number((await q('SHOW server_version_num')).rows[0].server_version_num);
 assert.ok(pgVersion>=180000 && pgVersion<190000,'PG18_REQUIRED');
 const m=(await q(`SELECT migration_name,finished_at,rolled_back_at
 FROM _prisma_migrations WHERE migration_name=ANY($1)`,[expected])).rows;
 assert.equal(m.length,2,'BOTH_MIGRATIONS_REQUIRED');
 for(const x of m){assert.ok(x.finished_at && !x.rolled_back_at,x.migration_name);}
 for(const t of ['finance_accounts_v2','finance_journals_v2','finance_postings_v2',
                 'finance_cash_handoffs_v2','finance_cash_handoff_events_v2']){
  const r=await q('SELECT to_regclass($1) AS rel',[t]);
  assert.equal(r.rows[0].rel,t,'TABLE_MISSING_'+t);
  const count=await q('SELECT count(*)::int AS n FROM '+t);
  assert.equal(count.rows[0].n,0,'FRESH_DB_TABLE_NOT_EMPTY_'+t);
 }
 const triggers=(await q(`SELECT c.relname,t.tgname FROM pg_trigger t
 JOIN pg_class c ON c.oid=t.tgrelid
 WHERE c.relname=ANY($1) AND NOT t.tgisinternal`,
 [['finance_journals_v2','finance_postings_v2',
   'finance_cash_handoffs_v2','finance_cash_handoff_events_v2']])).rows;
 for(const trigger of ['finance_v2_journal_balance','finance_v2_posting_balance',
    'finance_v2_posting_currency','finance_cash_handoff_v2_guard',
    'finance_cash_handoff_event_v2_guard']){
    assert.ok(triggers.some(x=>x.tgname===trigger),'TRIGGER_MISSING_'+trigger);
 }
 const account=(suffix,category)=>q(`INSERT INTO finance_accounts_v2
 (account_key,owner_kind,category) VALUES ($1,'platform',$2) RETURNING id`,
 ['rc137.pg18.'+suffix+'.'+unique,category]);
 const a=(await account('cash','asset')).rows[0].id;
 const b=(await account('payable','liability')).rows[0].id;
 const makeJournal=async(label)=>{
  const event='rc137.pg18.'+label+'.'+unique;
  return (await q(`INSERT INTO finance_journals_v2
   (event_key,fingerprint,source_type,source_ref,description)
   VALUES($1,$2,'order',$3,'RC137 isolated PostgreSQL 18 assertion') RETURNING id`,
   [event,sha(event),'rc137'+unique])).rows[0].id;
 };
 await q('BEGIN');
 const journal=await makeJournal('balanced');
 await q('INSERT INTO finance_postings_v2(journal_id,line_no,account_id,debit_minor) VALUES($1,1,$2,100)',[journal,a]);
 await q('INSERT INTO finance_postings_v2(journal_id,line_no,account_id,credit_minor) VALUES($1,2,$2,100)',[journal,b]);
 await q("UPDATE finance_journals_v2 SET status='posted' WHERE id=$1",[journal]);
 await q('COMMIT');
 const sums=(await q(`SELECT SUM(debit_minor)::text debit,
 SUM(credit_minor)::text credit FROM finance_postings_v2 WHERE journal_id=$1`,[journal])).rows[0];
 assert.deepEqual(sums,{debit:'100',credit:'100'});
 await assert.rejects(
  ()=>q('DELETE FROM finance_postings_v2 WHERE journal_id=$1',[journal]),
  e=>e.code==='23514','POSTED_LEDGER_MUST_BE_IMMUTABLE');
 await q('BEGIN');
 const invalid=await makeJournal('unbalanced');
 await q('INSERT INTO finance_postings_v2(journal_id,line_no,account_id,debit_minor) VALUES($1,1,$2,100)',[invalid,a]);
 await q('INSERT INTO finance_postings_v2(journal_id,line_no,account_id,credit_minor) VALUES($1,2,$2,99)',[invalid,b]);
 await q("UPDATE finance_journals_v2 SET status='posted' WHERE id=$1",[invalid]);
 await assert.rejects(()=>q('COMMIT'),e=>e.code==='23514',
  'UNBALANCED_JOURNAL_MUST_BE_REJECTED');
 await q('ROLLBACK');
 const absent=await q('SELECT count(*)::int AS n FROM finance_journals_v2 WHERE id=$1',[invalid]);
 assert.equal(absent.rows[0].n,0,'FAILED_COMMIT_MUST_ROLLBACK');
 console.log('RC137_PG18_MIGRATIONS_APPLIED=PASS');
 console.log('RC137_PG18_FINANCE_TABLES_AND_TRIGGERS=PASS');
 console.log('RC137_PG18_BALANCED_JOURNAL=PASS');
 console.log('RC137_PG18_UNBALANCED_JOURNAL_REJECTED=PASS');
 console.log('RC137_PG18_POSTED_LEDGER_IMMUTABLE=PASS');
 console.log('RC137_PG18_LIVE_DATABASE_READS_WRITES=ZERO');
 console.log('RC137_PG18_STRIPE_WRITES=ZERO');
}catch(e){console.error('RC137_PG18_GATE=FAIL',e.message);process.exitCode=1;}
finally{await db.end().catch(()=>{});}
