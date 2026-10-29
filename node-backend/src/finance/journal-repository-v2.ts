import type {Pool} from 'pg';
import {prepareJournal,type JournalInput} from './journal-v2.js';

/** Append-only journal. Call only after independently verifying source evidence. */
export async function recordFinanceJournal(pool:Pool,entry:JournalInput){
 const plan=prepareJournal(entry);
 const c=await pool.connect();
 let transaction=false;
 try {
  await c.query('BEGIN');transaction=true;
  const ids=[...new Set(plan.lines.map(l=>l.accountKey))];
  const result=await c.query<{id:string;account_key:string;currency:string}>(
   'SELECT id::text,account_key,currency FROM finance_accounts_v2 WHERE account_key=ANY($1::text[]) FOR KEY SHARE',[ids]);
  if(result.rows.length!==ids.length||result.rows.some(a=>a.currency!=='mxn'))
   throw Error('FINANCE_ACCOUNTS_NOT_READY');
  const accounts=new Map(result.rows.map(a=>[a.account_key,a.id]));
  const created=await c.query<{id:string}>(
   "INSERT INTO finance_journals_v2(event_key,fingerprint,source_type,source_ref,description,status) VALUES($1,$2,$3,$4,$5,'building') ON CONFLICT(event_key) DO NOTHING RETURNING id::text",
   [plan.eventKey,plan.fingerprint,plan.sourceType,plan.sourceRef,plan.description]);
  let id=created.rows[0]?.id;
  if(!id){
   const prior=await c.query<{id:string;fingerprint:string;status:string}>(
    'SELECT id::text,fingerprint,status FROM finance_journals_v2 WHERE event_key=$1 FOR UPDATE',[plan.eventKey]);
   const row=prior.rows[0];
   if(!row||row.status!=='posted'||row.fingerprint!==plan.fingerprint)
    throw Error('FINANCE_DUPLICATE_EVENT_DIFFERENT_CONTENT');
   await c.query('COMMIT');transaction=false;
   return {journalId:row.id,replayed:true};
  }
  for(const line of plan.lines){
   await c.query(
    'INSERT INTO finance_postings_v2(journal_id,line_no,account_id,debit_minor,credit_minor) VALUES($1,$2,$3,$4,$5)',
    [id,line.lineNo,accounts.get(line.accountKey),
     (line.side==='debit'?line.amountMinor:0n).toString(),
     (line.side==='credit'?line.amountMinor:0n).toString()]);
  }
  await c.query("UPDATE finance_journals_v2 SET status='posted' WHERE id=$1",[id]);
  await c.query('COMMIT');transaction=false;
  return {journalId:id,replayed:false};
 } catch (e) {
  if(transaction)await c.query('ROLLBACK').catch(()=>{});
  throw e;
 } finally {c.release();}
}
