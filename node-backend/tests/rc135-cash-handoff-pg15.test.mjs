import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';

let safe=false;
try{
 const u=new URL(process.env.DATABASE_URL??'');
 safe=process.env.RC133_FINANCE_DB_TEST==='true'&&
  process.env.NODE_ENV==='staging'&&u.hostname==='127.0.0.1'&&
  u.port==='15435'&&u.pathname==='/tala_node_stage';
}catch{}
test('RC13.5 PostgreSQL 15: cash handoff schema and immutable audit triggers',
 {skip:!safe},async()=>{
 const pool=new Pool({connectionString:process.env.DATABASE_URL});
 try{
  const tables=await pool.query(
   "SELECT to_regclass('finance_cash_handoffs_v2')::text AS handoff,"+
   "to_regclass('finance_cash_handoff_events_v2')::text AS events");
  assert.equal(tables.rows[0].handoff,'finance_cash_handoffs_v2');
  assert.equal(tables.rows[0].events,'finance_cash_handoff_events_v2');
  const triggers=await pool.query(
   "SELECT tgname FROM pg_trigger WHERE tgrelid IN "+
   "('finance_cash_handoffs_v2'::regclass,'finance_cash_handoff_events_v2'::regclass) "+
   "AND NOT tgisinternal");
  const names=triggers.rows.map(x=>x.tgname);
  assert.ok(names.includes('finance_cash_handoff_v2_guard'));
  assert.ok(names.includes('finance_cash_handoff_event_v2_guard'));
  const states=await pool.query(
   "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint "+
   "WHERE conrelid='finance_cash_handoffs_v2'::regclass AND contype='c'");
  assert.ok(states.rows.some(x=>/initiated/.test(x.definition)&&/confirmed/.test(x.definition)));
 }finally{await pool.end();}
});
