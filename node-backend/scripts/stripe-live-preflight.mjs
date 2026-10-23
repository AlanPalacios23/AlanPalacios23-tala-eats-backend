#!/usr/bin/env node
// Read-only Stripe LIVE preflight. Never prints keys, URLs, usernames or passwords.
// No imports of app/config, no network calls and no payment API calls.
import { readFileSync } from 'node:fs';
const envPath = process.argv[2];
if (!envPath || process.argv.length !== 3) {
  console.error('USAGE: node scripts/stripe-live-preflight.mjs /absolute/private/env/path');
  process.exit(2);
}
let lines;
try { lines = readFileSync(envPath,'utf8').split(/\r?\n/); }
catch { console.error('CONFIG_FILE_UNREADABLE'); process.exit(2); }
const vars={};
for(const raw of lines){
  const line=raw.trim();
  if(!line || line.startsWith('#') || !line.includes('='))continue;
  const i=line.indexOf('=');
  const key=line.slice(0,i).trim();
  const value=line.slice(i+1).trim().replace(/^(['"])(.*)\1$/,'$2');
  vars[key]=value;
}
const checks=[
  ['NODE_ENV_PRODUCTION',vars.NODE_ENV==='production'],
  ['LIVE_EXPLICIT_OPT_IN',vars.STRIPE_LIVE_ENABLED==='true'],
  ['STRIPE_LIVE_KEY',/^(sk_live_|rk_live_)[a-zA-Z0-9]{16,}$/.test(vars.STRIPE_SECRET_KEY||'')],
  ['STRIPE_LIVE_PUBLISHABLE_KEY',/^pk_live_[a-zA-Z0-9]{16,}$/.test(vars.STRIPE_PUBLISHABLE_KEY||'')],
  ['STRIPE_WEBHOOK_SECRET_PRESENT',/^whsec_[a-zA-Z0-9]{16,}$/.test(vars.STRIPE_WEBHOOK_SECRET||'')],
  ['FINANCIAL_WRITES_ENABLED',vars.STRIPE_FINANCIAL_WRITES_ENABLED==='true'],
  ['PRODUCTION_RELEASE_APPROVED',vars.STRIPE_LIVE_RELEASE_APPROVED==='true'],
  // Code-level refund compensation remains unimplemented in current RC8.
  ['REFUND_DISPUTE_COMPENSATION_IMPLEMENTED',false],
  // Cannot infer production DB/Redis readiness from a file alone.
  ['PRODUCTION_DB_REDIS_AND_RECOVERY_VERIFIED',false],
  ['LIVE_SIGNED_WEBHOOK_AND_TEST_PAYMENT_E2E_VERIFIED',false],
];
for(const [name,pass] of checks)console.log(name+'='+(pass?'PASS':'BLOCKED'));
console.log('STRIPE_LIVE_ACTIVATION='+ (checks.every(x=>x[1])?'ELIGIBLE':'BLOCKED'));
process.exit(checks.every(x=>x[1])?0:1);
