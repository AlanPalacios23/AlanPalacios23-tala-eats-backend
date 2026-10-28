#!/usr/bin/env node
/**
 * Treasury RC9 LIVE release preflight, read-only and fail-closed.
 * Never calls Stripe, PostgreSQL or production endpoints, never changes flags.
 * Exit 0 only means source is ready for the NEXT manual live attestation,
 * not that withdrawals can be enabled.
 */
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const load=(path)=>readFileSync(resolve(root,path),'utf8');
const checks=[];
const check=(name,ok,detail='')=>checks.push({name,ok,detail});
const exists=(p)=>existsSync(resolve(root,p));
const policy=load('src/live/treasury-policy.ts');
const config=load('src/config.ts');
const router=load('src/live/treasury-router.ts');
const worker=load('src/live/production-worker.ts');
const dispatch=load('src/live/treasury-dispatch.ts');
check('MONEY_MOVEMENT_LOCKED',/NODE_TREASURY_LIVE_EXECUTION_ENABLED\s*=\s*false/.test(policy),'Release source switch must stay OFF until certified');
check('CONNECT_TRANSFERS_CONFIG_GUARD',/LIVE_CONNECT_PAYOUTS_REQUIRE_SEPARATE_AUDIT/.test(config),'Production guard must remain in place');
check('CONNECT_WEBHOOK_SIGNING_SECRET',/STRIPE_CONNECT_WEBHOOK_SECRET/.test(config)&&/CONNECT_WEBHOOK_REQUIRES_SEPARATE_SIGNING_SECRET/.test(config));
check('RECONCILIATION_WORKER_WIRED',/drainTreasuryConnectEvents/.test(worker)&&/scanUnknownTreasuryPayouts/.test(worker));
check('DURABLE_DISPATCH',/state='submitted'/.test(dispatch)&&/state='unknown'/.test(dispatch));
check('MOBILE_WITHDRAWAL_CONTRACT',/server_allows_requests:false/.test(router)&&/TREASURY_WITHDRAWALS_NOT_RELEASED/.test(router));
for(const name of ['treasury-reservations.ts','treasury-dual-approval.ts','treasury-admin-step-up.ts','treasury-totp-rate-limit.ts','treasury-bank-verification.ts','treasury-connect-webhook.ts','treasury-unknown-recovery.ts','treasury-transfer-reservations.ts']){
 check('MODULE_'+name,exists('src/live/'+name));
}
for(const script of ['ci-rc9-treasury-transactions-pg15.mjs','ci-rc9-treasury-signed-webhooks-pg15.mjs','ci-rc9-treasury-unknown-recovery-pg15.mjs','ci-rc9-treasury-admin-step-up-pg15.mjs','ci-rc9-treasury-transfers-pg15.mjs']){
 check('PG_CI_'+script,exists('scripts/'+script));
}
const fail=checks.filter(x=>!x.ok);
for(const c of checks)console.log((c.ok?'PASS':'FAIL')+' '+c.name+(c.detail?' — '+c.detail:''));
console.log('LIVE_WITHDRAWALS_AUTHORIZED=NO');
console.log('REQUIRED_EXTERNAL_EVIDENCE=STRIPE_CONNECT_TEST_E2E,BANK_MX,REFUNDS_DISPUTES,LIVE_DB_BACKUP_RESTORE,WEBHOOK_REAL_DELIVERY,ADMIN_SIGNOFF');
console.log('PREDEPLOY_SOURCE_PREFLIGHT='+(fail.length?'FAIL':'PASS_READ_ONLY'));
process.exitCode=fail.length?1:0;
