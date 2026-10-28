#!/usr/bin/env node
/**
 * RC11.0: READ-ONLY preflight against the isolated LIVE PostgreSQL cluster.
 * Does not modify users, database schema, PM2, Stripe, dispatch or payout flags.
 * Run only under tala-node-stage using the existing protected LIVE env file.
 */
import {Client} from 'pg';

const required=['NODE_ENV','DATABASE_URL'];
for(const key of required)if(!process.env[key])throw Error('RC110_PREFLIGHT_ABORT=MISSING_ENV_'+key);
if(process.env.NODE_ENV!=='production')throw Error('RC110_PREFLIGHT_ABORT=NOT_PRODUCTION');
const url=new URL(process.env.DATABASE_URL);
if(!['postgres:','postgresql:'].includes(url.protocol)||
    url.hostname!=='127.0.0.1'||url.port!=='15445'||
    url.pathname!=='/talaeats_live'||
    url.username==='tala_node_stage')
 throw Error('RC110_PREFLIGHT_ABORT=NOT_ISOLATED_LIVE_PG');
const client=new Client({connectionString:process.env.DATABASE_URL,
  connectionTimeoutMillis:5000,query_timeout:6000});
let connected=false;
try{
 await client.connect();connected=true;
 await client.query('BEGIN READ ONLY');
 const r=await client.query(`
  SELECT current_database() AS name,
   EXISTS(SELECT 1 FROM information_schema.columns
     WHERE table_schema=current_schema()
       AND table_name='onboarding_applications' AND column_name='plate') AS application_plate,
   EXISTS(SELECT 1 FROM information_schema.columns
     WHERE table_schema=current_schema()
       AND table_name='driver_profiles' AND column_name='plate') AS profile_plate
 `);
 const row=r.rows[0];
 if(row?.name!=='talaeats_live')throw Error('RC110_PREFLIGHT_ABORT=WRONG_DATABASE');
 console.log('RC110_LIVE_DB_IDENTITY=PASS');
 console.log('RC110_DRIVER_APPLICATION_PLATE_COLUMN='+(row.application_plate?'PASS':'MISSING'));
 console.log('RC110_DRIVER_PROFILE_PLATE_COLUMN='+(row.profile_plate?'PASS':'MISSING'));
 console.log('RC110_DB_WRITES=NONE_READ_ONLY_TRANSACTION');
 if(!row.application_plate||!row.profile_plate){
  console.log('RC110_LIVE_DRIVER_SIGNUP=HOLD_SCHEMA_MIGRATION_PENDING');
  process.exitCode=2;
 }else{
  console.log('RC110_LIVE_DRIVER_SIGNUP_SCHEMA=READY');
 }
}finally{
 if(connected)await client.query('ROLLBACK').catch(()=>{});
 await client.end().catch(()=>{});
}
