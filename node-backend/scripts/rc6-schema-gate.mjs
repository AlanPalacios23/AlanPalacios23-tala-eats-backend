#!/usr/bin/env node
// RC6 staging candidate guard: offline and read-only, never touches DB/Kali.
// Exact review for the two cumulative Node staging migrations since the old PM2
// checkout. If schemas change again, review and update this gate explicitly.
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.argv.length!==3||process.argv[2]!=='--check'){
 console.error('USAGE: node scripts/rc6-schema-gate.mjs --check');
 process.exit(2);
}
const read=(name)=>readFileSync(path.join(root,name),'utf8');
const checks=[];
function verify(name,result){
 checks.push({name,pass:Boolean(result)});
 if(!result)console.error('RC6_FAIL_'+name);
}
function normalizedSql(src){
 return src.split('\n').filter(x=>!x.trim().startsWith('--'))
  .join(' ').replace(/\s+/g,' ').trim();
}
const support='prisma/migrations/20261020_admin_helpdesk_reply/migration.sql';
const courier='prisma/migrations/20261021_driver_verification_fail_closed/migration.sql';
for(const name of [support,courier])
 verify('MIGRATION_FILE_'+path.basename(path.dirname(name)),existsSync(path.join(root,name)));
if(checks.some(x=>!x.pass))process.exit(1);
const expectedSupport=`ALTER TABLE "support_tickets" ADD COLUMN "admin_reply" TEXT NOT NULL DEFAULT '', ADD COLUMN "responded_at" TIMESTAMP(3);`;
const expectedCourier=`ALTER TABLE "driver_profiles" ALTER COLUMN "is_verified" SET DEFAULT FALSE;`;
verify('ADMIN_HELPDESK_EXACT_SQL',normalizedSql(read(support))===expectedSupport);
verify('DRIVER_UNVERIFIED_EXACT_SQL',normalizedSql(read(courier))===expectedCourier);
const schema=read('prisma/schema.prisma');
verify('DRIVER_PRISMA_UNVERIFIED_DEFAULT',
 /isVerified\s+Boolean\s+@default\(false\)\s+@map\("is_verified"\)/.test(schema));
verify('SUPPORT_REPLY_SCHEMA',
 /adminReply\s+String\s+@default\(""\)\s+@map\("admin_reply"\)/.test(schema)&&
 /respondedAt\s+DateTime\?\s+@map\("responded_at"\)/.test(schema));
const config=read('src/config.ts');
verify('FINANCIAL_WRITES_DISABLED',
 config.includes("STRIPE_FINANCIAL_WRITES_ENABLED: z.literal('false')"));
const safeUpdater=read('scripts/actualizar.sh');
verify('MIGRATION_AUTO_UPDATER_BLOCKED',
 safeUpdater.includes('ABORT_PRISMA_CHANGE_REQUIRES_REVIEWED_MIGRATION_AND_MANUAL_RELEASE'));
const prom=read('scripts/kali-stage-first-pm2-promote.sh');
verify('PROMOTION_REQUIRES_RESTORE',
 prom.includes('kali-stage-backup.py --apply')&&
 prom.includes('kali-stage-test-restore.py --apply')&&
 prom.includes('kali-stage-postdeploy-smoke.sh')&&
 prom.includes('ABORT_PRISMA_PENDING_OR_FAILED_RUN_SEPARATE_STAGE_MIGRATION_GATE'));
verify('POSTDEPLOY_WORKER_CHECK',
 read('scripts/stage-readonly-smoke.mjs').includes('PM2_WORKER_HEARTBEAT'));
for(const c of checks)console.log('RC6_'+c.name+'='+(c.pass?'PASS':'FAIL'));
console.log('RC6_SCHEMA_CODE_GATE='+ (checks.every(x=>x.pass)?'PASS':'FAIL'));
console.log('RC6_PRODUCTION_CUTOVER=NOT_AUTHORIZED');
if(checks.some(x=>!x.pass))process.exitCode=1;
