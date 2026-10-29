import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const cmd=new URL('../scripts/rc119-kali-live-blockers-diagnostic.mjs',
 import.meta.url);
const src=readFileSync(cmd,'utf8');
const sql=readFileSync(new URL('../scripts/sql/rc119-live-blockers-summary.sql',
 import.meta.url),'utf8');
test('RC119 operational diagnostics compile and refuse arbitrary users',()=>{
 const syntax=spawnSync(process.execPath,['--check',cmd.pathname],
  {encoding:'utf8'});
 assert.equal(syntax.status,0,syntax.stderr);
 const attempt=spawnSync(process.execPath,[cmd.pathname],{
  encoding:'utf8',env:{HOME:'/tmp',USER:'nobody',PATH:'/usr/bin:/bin'},
 });
 assert.notEqual(attempt.status,0);
});
test('RC119 uses pinned LIVE local DB and private configuration without prints',()=>{
 for(const token of ['PINNED_RELEASE_MISMATCH','ENV_PERMISSIONS',
  'WRONG_DATABASE',"pg.port!=='15445'",
  "pg.pathname!=='/tala_node_live'",'tala-node-stage',
  'RC119_COMMERCIAL_GO=NOT_AUTHORIZED',
  'RC119_DATABASE_AND_STRIPE_WRITES=NONE',
  'RC119_OLD_OUTBOX_EVENTS_ARE_NOT_AUTOMATICALLY_DELETED=YES'])
  assert.ok(src.includes(token),token);
 assert.doesNotMatch(src,/console\.log\([^)]*(?:stripeAccountId|identity_email|email|longitude|secret|password)/i);
 assert.doesNotMatch(src,/stripe\.(?:transfers|paymentIntents|refunds|payouts)\./);
});
test('RC119 counter SQL isolates seller, owner, driver and outbox backlog',()=>{
 for(const token of ['verification_status','onboarding_status',
  'owner_approved_at','tala_live_merchant_accounts','driver_profiles',
  'is_verified','is_online','event_outbox','outboxStaleNeverAttempted',
  'outboxStalePreviouslyAttempted','outboxStaleOrderEvents',
  'outboxStaleOtherEvents','outboxRetryDue','outboxDeadLetter'])
  assert.ok(sql.includes(token),token);
 assert.doesNotMatch(sql.replace(/^--[^\n]*\n/gm,''),
  /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|CREATE|ALTER|FOR UPDATE)\b/i);
 assert.doesNotMatch(sql,/\bSELECT\s+(?:email|password|gps|lat|lng)\b/i);
});
