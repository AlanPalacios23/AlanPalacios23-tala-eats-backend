#!/usr/bin/env node
/**
 * RC8.6 Kali release preflight. READ-ONLY with respect to PM2, PostgreSQL,
 * Redis, Stripe and Cloudflare. Intended for the existing service account.
 * Does not activate production settings, run database migrations or charge.
 */
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';

export const SHA=/^[a-f0-9]{40}$/;
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const required=[
  'dist/server.js','dist/live/production-worker.js',
  'dist/live/refund-reconciliation.js','dist/live/payee-finance-router.js',
  'dist/live/merchant-finance-router.js','dist/live/payee-allocation.js',
  'dist/live/transfer-planning.js',
  'prisma/migrations/20261023_rc84_merchant_finance_controls/migration.sql',
  'prisma/migrations/20261024_rc85_restaurant_driver_cash/migration.sql',
  'ecosystem.production.config.cjs',
  'scripts/rc8-postdeploy-audit.mjs',
];
const privateFile='/home/tala-node-stage/.config/talaeats-node-live.env';
function checkSource(){
  const expected=process.argv[2];
  if(process.argv.length!==3||!SHA.test(expected??''))throw Error('EXACT_SHA_REQUIRED');
  if(process.getuid?.()===0||process.env.USER!=='tala-node-stage'||
    homedir()!=='/home/tala-node-stage')throw Error('SERVICE_IDENTITY_REQUIRED');
  const expectedDir=join('/home/tala-node-stage/tala-node-releases',expected,'node-backend');
  if(root!==expectedDir)throw Error('SHA_RELEASE_DIRECTORY_REQUIRED');
  const git=execFileSync('git',['-C',resolve(root,'..'),'rev-parse','HEAD'],{
    encoding:'utf8',timeout:7000,stdio:['ignore','pipe','ignore']}).trim();
  if(git!==expected)throw Error('SOURCE_SHA_MISMATCH');
  const dirty=execFileSync('git',['-C',resolve(root,'..'),'status','--porcelain','--untracked-files=no'],{
    encoding:'utf8',timeout:7000,stdio:['ignore','pipe','ignore']}).trim();
  if(dirty)throw Error('SOURCE_NOT_CLEAN');
  for(const path of required)if(!existsSync(join(root,path)))throw Error('REQUIRED_BUILD_OR_MIGRATION_MISSING');
  const env=lstatSync(privateFile);
  if(!env.isFile()||env.isSymbolicLink()||(env.mode&0o777)!==0o600||
     env.uid!==process.getuid?.())throw Error('PRIVATE_LIVE_ENV_PERMISSIONS_INVALID');
  // We intentionally DO NOT source the .env as shell code or print any lines.
  const raw=readFileSync(privateFile,'utf8');
  if(raw.length>16000||/\r/.test(raw))throw Error('PRIVATE_ENV_INVALID');
  const vars=new Map();
  for(const line of raw.split('\n')){
    if(!line||line.startsWith('#'))continue;
    const pos=line.indexOf('=');
    if(pos<1)throw Error('PRIVATE_ENV_LINE_INVALID');
    const name=line.slice(0,pos),value=line.slice(pos+1);
    if(!/^[A-Z][A-Z0-9_]*$/.test(name)||vars.has(name)||
       value.includes('\n'))throw Error('PRIVATE_ENV_DUPLICATE_OR_INVALID');
    vars.set(name,value);
  }
  if(vars.get('NODE_ENV')!=='production'||vars.get('PORT')!=='18190'||
     vars.get('STRIPE_CONNECT_TRANSFERS_ENABLED')!=='false')
    throw Error('LIVE_ENV_MODE_OR_TRANSFERS_INVALID');
  // Preparation must not accidentally activate real charges. An approved
  // cutover is an entirely separate, explicit operator procedure.
  for(const name of ['STRIPE_LIVE_ENABLED','STRIPE_LIVE_RELEASE_APPROVED',
      'STRIPE_FINANCIAL_WRITES_ENABLED']){
    if(vars.get(name)!=='false')throw Error('PREPARATION_REQUIRES_LIVE_CHARGES_OFF');
  }
  const key=vars.get('STRIPE_SECRET_KEY')??'';
  const pub=vars.get('STRIPE_PUBLISHABLE_KEY')??'';
  const webhook=vars.get('STRIPE_WEBHOOK_SECRET')??'';
  const acct=vars.get('STRIPE_PLATFORM_ACCOUNT_ID')??'';
  if(!/^(sk|rk)_live_[A-Za-z0-9]{16,}$/.test(key)||
     !/^pk_live_[A-Za-z0-9]{16,}$/.test(pub)||
     !/^whsec_[A-Za-z0-9]{16,}$/.test(webhook)||
     !/^acct_[A-Za-z0-9]+$/.test(acct))
    throw Error('LIVE_CREDENTIAL_FORMAT_MISSING');
  const db=new URL(vars.get('DATABASE_URL')??'');
  const redis=new URL(vars.get('REDIS_URL')??'');
  if(!['postgres:','postgresql:'].includes(db.protocol)||!db.username||
    !db.password||db.pathname==='/tala_node_stage'||db.username==='tala_node_stage'||
    (db.hostname==='127.0.0.1'&&db.port==='15435'))
    throw Error('STAGING_DATABASE_FORBIDDEN');
  if(!['redis:','rediss:'].includes(redis.protocol)||!redis.password||
    (redis.hostname==='127.0.0.1'&&redis.port==='16379'&&
    (redis.pathname===''||redis.pathname==='/0')))
    throw Error('STAGING_REDIS_FORBIDDEN');
  return expected;
}
try{
  const sha=checkSource();
  console.log('RC86_EXACT_SHA='+sha);
  console.log('RC86_PRISMA_MIGRATIONS_PRESENT=PASS');
  console.log('RC86_BUILT_PM2_API_AND_WORKER=PASS');
  console.log('RC86_PRIVATE_LIVE_ENV=PASS');
  console.log('RC86_LIVE_CREDENTIAL_FORMAT=PASS');
  console.log('RC86_STAGING_DB_ISOLATION=PASS');
  console.log('RC86_FINANCIAL_WRITES=OFF');
  console.log('RC86_TRANSFER_WRITES=OFF');
  console.log('RC86_DEPLOY_CANDIDATE_PREPARATION=PASS_NO_PUBLIC_CHANGES');
  console.log('RC86_REAL_MONEY_GO_LIVE=NOT_AUTHORIZED');
}catch{
  // Secrets, connection URLs and operational error messages are never logged.
  console.log('RC86_DEPLOY_CANDIDATE_PREPARATION=HOLD');
  process.exitCode=1;
}
