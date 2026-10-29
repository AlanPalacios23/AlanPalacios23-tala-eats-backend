import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {prepareJournal,JournalInvalid} from '../dist/finance/journal-v2.js';

const base={
 eventKey:'stripe.captured.pi_ABC123:order_55',
 sourceType:'stripe_event',sourceRef:'order:55',
 description:'Verified source receipt - bookkeeping only',
 lines:[
  {accountKey:'asset.stripe_pending',side:'debit',amountMinor:25300n},
  {accountKey:'liability.restaurant_8',side:'credit',amountMinor:17000n},
  {accountKey:'liability.driver_15',side:'credit',amountMinor:3200n},
  {accountKey:'revenue.platform',side:'credit',amountMinor:5100n},
 ],
};
test('RC13.3 exact 253.00 centavo conservation, stable canonical fingerprint',()=>{
 const plan=prepareJournal(base);
 assert.equal(plan.currency,'mxn');
 assert.equal(plan.debitsMinor,25300n);
 assert.equal(plan.creditsMinor,25300n);
 assert.equal(plan.lines.length,4);
 assert.equal(plan.fingerprint.length,64);
 const rerun=prepareJournal({...base,lines:[...base.lines].reverse()});
 assert.equal(rerun.fingerprint,plan.fingerprint);
});
test('RC13.3 different payment amounts cannot replay under one event identity',()=>{
 const changed=prepareJournal({...base,lines:[
  {...base.lines[0],amountMinor:25301n},
  {...base.lines[1],amountMinor:17001n},
  ...base.lines.slice(2),
 ]});
 assert.notEqual(changed.fingerprint,prepareJournal(base).fingerprint);
});
test('RC13.3 rejects imbalance, negative, zero and fractional values',()=>{
 assert.throws(()=>prepareJournal({...base,lines:base.lines.slice(0,3)}),
  /JOURNAL_UNBALANCED/);
 assert.throws(()=>prepareJournal({...base,lines:[
  {accountKey:'asset.stripe_pending',side:'debit',amountMinor:-1n},
  ...base.lines.slice(1),
 ]}),/JOURNAL_AMOUNT_INVALID/);
 assert.throws(()=>prepareJournal({...base,lines:[
  {accountKey:'asset.stripe_pending',side:'debit',amountMinor:0n},
  ...base.lines.slice(1),
 ]}),/JOURNAL_AMOUNT_INVALID/);
 assert.throws(()=>prepareJournal({...base,lines:[
  {accountKey:'asset.stripe_pending',side:'debit',amountMinor:25300.5},
  ...base.lines.slice(1),
 ]}),/JOURNAL_AMOUNT_INVALID/);
});
test('RC13.3 rejects invalid event IDs and source references',()=>{
 assert.throws(()=>prepareJournal({...base,eventKey:'hi'}),JournalInvalid);
 assert.throws(()=>prepareJournal({...base,sourceRef:'invalid space'}),JournalInvalid);
 assert.throws(()=>prepareJournal({...base,sourceType:'unknown'}),JournalInvalid);
});
test('RC13.3 migration: only new tables, immutable and deferred balanced commit',()=>{
 const sql=readFileSync(new URL(
  '../prisma/migrations/20261029_rc133_finance_general_ledger_v2/migration.sql',
  import.meta.url),'utf8');
 for(const table of ['finance_accounts_v2','finance_journals_v2',
  'finance_postings_v2'])assert.match(sql,new RegExp('CREATE TABLE '+table));
 assert.match(sql,/DEFERRABLE INITIALLY DEFERRED/);
 assert.match(sql,/FINANCE_V2_UNBALANCED/);
 assert.match(sql,/FINANCE_V2_IMMUTABLE_DELETE/);
 assert.match(sql,/FINANCE_V2_IMMUTABLE_UPDATE/);
 assert.match(sql,/FINANCE_V2_CURRENCY_MISMATCH/);
 assert.doesNotMatch(sql,/DROP TABLE|TRUNCATE TABLE|UPDATE orders|DELETE FROM orders/i);
});
