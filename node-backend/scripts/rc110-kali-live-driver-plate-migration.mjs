#!/usr/bin/env node
/**
 * RC11.0 isolated production driver plate migration.
 * --plan   read-only schema + Prisma migration inventory
 * --backup pg_dump custom archive + pg_restore listing, no writes to DB
 * --apply  explicit token + verified recent archive, Prisma deploy one migration
 * --verify read-only SQL+Prisma journal verification
 * No PM2/Stripe/Redis/frontend modifications.
 */
import {readFileSync,writeFileSync,mkdirSync,statSync,lstatSync,existsSync,
  openSync,closeSync,rmSync,readdirSync,createReadStream} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import pg from 'pg';

const mode=process.argv[2]??'';
const token=process.argv[3]??'';
if(!['--plan','--backup','--apply','--verify'].includes(mode)||
    (mode==='--apply'&&
      (process.argv.length!==4||token!=='I_APPROVE_RC110_ONE_PLATE_COLUMN_ONLY'))||
    (mode!=='--apply'&&process.argv.length!==3))
 throw Error('RC110_SCHEMA_ABORT=MODE_OR_APPROVAL');
if(process.getuid?.()===0||process.env.USER!=='tala-node-stage'||
   homedir()!=='/home/tala-node-stage')
 throw Error('RC110_SCHEMA_ABORT=SERVICE_USER_ONLY');
if(process.env.NODE_ENV!=='production')
 throw Error('RC110_SCHEMA_ABORT=NOT_PRODUCTION');
const envFile=join(homedir(),'.config/talaeats-node-live.env');
const envStat=lstatSync(envFile);
if(!envStat.isFile()||envStat.isSymbolicLink()||
   (envStat.mode&0o777)!==0o600||envStat.uid!==process.getuid())
 throw Error('RC110_SCHEMA_ABORT=LIVE_ENV_PERMISSIONS');
const sha=process.env.RC110_SHA;
if(typeof sha!=='string'||!/^[0-9a-f]{40}$/.test(sha))
 throw Error('RC110_SCHEMA_ABORT=SHA_REQUIRED');
const root=resolve('..');
if(root!==join(homedir(),'tala-node-releases',sha)||
   execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==sha||
   execFileSync('git',['-C',root,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())
 throw Error('RC110_SCHEMA_ABORT=UNPINNED_RELEASE');
const name='20261028_rc97_driver_plate_registration';
const sql=readFileSync(join('prisma','migrations',name,'migration.sql'),'utf8');
if(!sql.includes('ALTER TABLE "onboarding_applications"')||
   !sql.includes('ADD COLUMN IF NOT EXISTS "plate" VARCHAR(30) NOT NULL DEFAULT'))
 throw Error('RC110_SCHEMA_ABORT=WRONG_MIGRATION_BODY');

const url=new URL(process.env.DATABASE_URL||'');
if(!['postgres:','postgresql:'].includes(url.protocol)||
  url.hostname!=='127.0.0.1'||url.port!=='15445'||
  url.pathname!=='/tala_node_live'||!url.password||
  !url.username||decodeURIComponent(url.username)==='tala_node_stage')
 throw Error('RC110_SCHEMA_ABORT=NOT_ISOLATED_LIVE_PG');
if(process.env.STRIPE_CONNECT_TRANSFERS_ENABLED!=='false')
 throw Error('RC110_SCHEMA_ABORT=UNEXPECTED_LIVE_PAYOUT_FLAG');

const migrations=readdirSync('prisma/migrations',{withFileTypes:true})
 .filter(x=>x.isDirectory()&&existsSync(join('prisma','migrations',x.name,'migration.sql')))
 .map(x=>x.name);
if(!migrations.includes(name))throw Error('RC110_SCHEMA_ABORT=TARGET_MIGRATION_MISSING');

async function snapshot(){
 const client=new pg.Client({connectionString:process.env.DATABASE_URL,
   connectionTimeoutMillis:5000,statement_timeout:15000,query_timeout:15000});
 await client.connect();
 try{
  await client.query('BEGIN READ ONLY');
  const identity=(await client.query(
    "SELECT current_database() AS db, inet_server_port() AS port, "+
    "current_schema() AS schema_name, "+
    "EXISTS(SELECT 1 FROM information_schema.columns "+
    " WHERE table_schema='public' AND table_name='onboarding_applications' "+
    " AND column_name='plate') AS application_plate, "+
    "EXISTS(SELECT 1 FROM information_schema.columns "+
    " WHERE table_schema='public' AND table_name='driver_profiles' "+
    " AND column_name='plate') AS profile_plate"
  )).rows[0];
  if(identity?.db!=='tala_node_live'||identity?.port!==15445||
     identity?.schema_name!=='public'||identity?.profile_plate!==true)
   throw Error('RC110_SCHEMA_ABORT=DATABASE_IDENTITY_OR_PROFILE_COLUMN');
  const journal=(await client.query(
    'SELECT migration_name,finished_at,rolled_back_at,checksum '+
    'FROM public._prisma_migrations ORDER BY started_at')).rows;
  if(journal.some(x=>!x.finished_at&&!x.rolled_back_at))
   throw Error('RC110_SCHEMA_ABORT=FAILED_PRISMA_JOURNAL');
  const applied=new Map(journal.filter(x=>x.finished_at&&!x.rolled_back_at)
    .map(x=>[x.migration_name,x]));
  const unknown=[...applied.keys()].filter(x=>!migrations.includes(x));
  const missing=migrations.filter(x=>!applied.has(x));
  if(unknown.length)
   throw Error('RC110_SCHEMA_ABORT=UNKNOWN_APPLIED_MIGRATIONS');
  const ready=missing.length===1&&missing[0]===name&&identity.application_plate===false;
  const done=missing.length===0&&identity.application_plate===true&&applied.has(name);
  return {ready,done,missing,identity};
 }finally{
  await client.query('ROLLBACK').catch(()=>{});
  await client.end();
 }
}
const state=await snapshot();
console.log('RC110_LIVE_DATABASE_IDENTITY=PASS');
console.log('RC110_APPLICATION_PLATE_COLUMN='+(state.identity.application_plate?'PRESENT':'MISSING'));
console.log('RC110_DRIVER_PROFILE_COLUMN=PASS');
console.log('RC110_PENDING_MIGRATIONS='+state.missing.join(','));
if(mode==='--plan'){
 console.log('RC110_SCHEMA_PLAN='+(state.ready?'PASS_ONE_ADD_COLUMN_ONLY':state.done?'ALREADY_APPLIED':'HOLD'));
 console.log('RC110_DB_STRIPE_PM2_WRITES=NONE');
 process.exitCode=(state.ready||state.done)?0:2;
}else if(mode==='--verify'){
 if(!state.done)throw Error('RC110_SCHEMA_VERIFY=HOLD_NOT_APPLIED');
 console.log('RC110_SCHEMA_VERIFY=PASS');
 console.log('RC110_STRIPE_PM2=UNMODIFIED');
}else{
 if(!state.ready)throw Error('RC110_SCHEMA_ABORT=NOT_EXACTLY_ONE_PENDING_MIGRATION');
 const dir=join(homedir(),'.local','share','talaeats-node-live','backups','rc110');
 if(existsSync(dir)){
  const ds=lstatSync(dir);
  if(!ds.isDirectory()||ds.isSymbolicLink()||ds.uid!==process.getuid()||
     (ds.mode&0o777)!==0o700)
   throw Error('RC110_SCHEMA_ABORT=UNSAFE_BACKUP_DIR');
 }else mkdirSync(dir,{recursive:true,mode:0o700});
 const receiptPath=join(dir,'receipt-'+sha+'.json');
 const args=['--host','127.0.0.1','--port','15445','--username',
  decodeURIComponent(url.username),'--dbname','tala_node_live','--no-password'];
 const dbEnv={...process.env,PGPASSWORD:decodeURIComponent(url.password),
  PGCONNECT_TIMEOUT:'5'};
 const exec=(command,args,env=dbEnv,timeout=240000)=>{
  const r=spawnSync(command,args,{cwd:process.cwd(),env,encoding:'utf8',timeout,
    maxBuffer:4*1024*1024});
  if(r.error||r.status!==0)
   throw Error('RC110_SCHEMA_ABORT=BACKUP_OR_MIGRATION_COMMAND_FAILED:'+command);
  return r.stdout;
 };
 const archiveHash=async(path)=>{
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(path))hash.update(chunk);
  return hash.digest('hex');
 };
 if(mode==='--backup'){
  if(existsSync(receiptPath))throw Error('RC110_SCHEMA_ABORT=RECEIPT_EXISTS_REVIEW_FIRST');
  const stamp=new Date().toISOString().replaceAll(':','').replaceAll('.','');
  const archive=join(dir,'before-rc110-'+stamp+'.dump');
  const fd=openSync(archive,'wx',0o600);closeSync(fd);
  try{
   exec('pg_dump',[...args,'--format=custom','--file',archive],dbEnv,240000);
   if(statSync(archive).size<1024)throw Error('RC110_SCHEMA_ABORT=EMPTY_BACKUP');
   const listing=exec('pg_restore',['--list',archive],dbEnv,60000);
   if(!listing.includes('onboarding_applications')||
      !listing.includes('_prisma_migrations'))
    throw Error('RC110_SCHEMA_ABORT=INCOMPLETE_ARCHIVE');
   const receipt={sha,archive,created:Date.now(),size:statSync(archive).size,
    digest:await archiveHash(archive)};
   writeFileSync(receiptPath,JSON.stringify(receipt),{flag:'wx',mode:0o600});
   console.log('RC110_BACKUP=PASS_VERIFIED_ARCHIVE_LIST');
   console.log('RC110_BACKUP_FILE='+archive);
   console.log('RC110_RESTORE_TEST=NOT_PERFORMED');
   console.log('RC110_DB_STRIPE_PM2_WRITES=NONE');
  }catch(e){rmSync(archive,{force:true});throw e;}
 }else{
  if(!existsSync(receiptPath))throw Error('RC110_SCHEMA_ABORT=BACKUP_REQUIRED');
  const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));
  const ar=lstatSync(receipt.archive);
  if(!ar.isFile()||ar.isSymbolicLink()||ar.uid!==process.getuid()||
     (ar.mode&0o777)!==0o600||
     receipt.sha!==sha||Date.now()-receipt.created>30*60*1000||
     receipt.size!==ar.size||receipt.digest!==await archiveHash(receipt.archive))
    throw Error('RC110_SCHEMA_ABORT=INVALID_OR_STALE_BACKUP');
  console.log('RC110_ONE_PENDING_PRISMA_MIGRATION=PASS');
  console.log('RC110_BACKUP_ATTESTED=PASS');
  console.log('RC110_SCHEMA_APPLY=START');
  exec(process.execPath,['./node_modules/prisma/build/index.js','migrate','deploy'],
    process.env,180000);
  console.log('RC110_SCHEMA_APPLY=PRISMA_COMPLETED');
  console.log('RC110_SCHEMA_VERIFY=REQUIRES_SEPARATE_VERIFY_COMMAND');
  console.log('RC110_PM2_STRIPE=UNMODIFIED');
 }
}