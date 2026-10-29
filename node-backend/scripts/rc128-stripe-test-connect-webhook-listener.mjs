#!/usr/bin/env node
/** Stripe Connect TEST webhook receiver on 127.0.0.1:18193 only.
 * Used with a separate Stripe CLI TEST-mode Connect webhook signing secret.
 * Strict STAGING credentials and PostgreSQL identities; never enables HTTP
 * endpoints on the public LIVE backend or creates payouts/transfers.
 */
import {userInfo} from 'node:os';
import express from 'express';
import Stripe from 'stripe';
import {Pool} from 'pg';
import {config} from '../dist/config.js';
import {buildTreasuryConnectWebhookRouter,drainTreasuryConnectEvents}
 from '../dist/live/treasury-connect-webhook.js';

const fail=(reason)=>{throw Error(reason);};
if(process.argv.length!==4||process.argv[2]!=='--listen-test'||
 process.argv[3]!=='I_APPROVE_STRIPE_TEST_SIGNED_RECONCILIATION_ONLY')
 fail('RC128_SIGNED_WEBHOOK_EXPLICIT_TEST_CONSENT_REQUIRED');
const d=new URL(config.DATABASE_URL);
if(process.getuid?.()===0||userInfo().username!=='tala-node-stage'||
 config.NODE_ENV!=='staging'||d.hostname!=='127.0.0.1'||
 d.port!=='15435'||d.username!=='tala_node_stage'||
 d.pathname!=='/tala_node_stage'||!config.STRIPE_SECRET_KEY?.startsWith('sk_test_')||
 !config.STRIPE_CONNECT_WEBHOOK_SECRET?.startsWith('whsec_')||
 config.STRIPE_CONNECT_WEBHOOK_SECRET===config.STRIPE_WEBHOOK_SECRET)
 fail('RC128_STAGE_TEST_PROVIDER_AND_SIGNING_ISOLATION_HOLD');
for(const name of ['STRIPE_LIVE_ENABLED','STRIPE_FINANCIAL_WRITES_ENABLED',
 'STRIPE_CONNECT_TRANSFERS_ENABLED','STRIPE_MANUAL_SETTLEMENT_APPROVED']){
 if(process.env[name]!=='false')fail('RC128_LIVE_FINANCIAL_FLAGS_MUST_BE_OFF');
}
const stripe=new Stripe(config.STRIPE_SECRET_KEY,{maxNetworkRetries:0,timeout:10000});
const pool=new Pool({connectionString:config.DATABASE_URL,max:3,
 connectionTimeoutMillis:7000,statement_timeout:15000});
const app=express();
app.disable('x-powered-by');
app.use('/api/v1/webhooks',
 buildTreasuryConnectWebhookRouter(stripe,pool,config.STRIPE_CONNECT_WEBHOOK_SECRET,false));
let draining=false,stopping=false;
const drain=async()=>{
 if(draining||stopping)return;
 draining=true;
 try{
  const report=await drainTreasuryConnectEvents(pool,stripe,10,false);
  if(report.held)console.error('RC128_TEST_SIGNED_EVENT_REQUIRES_REVIEW');
 }catch{console.error('RC128_TEST_WEBHOOK_OR_STRIPE_READBACK_HOLD');}
 finally{draining=false;}
};
const server=app.listen(18193,'127.0.0.1',()=>{
 console.log('RC128_TEST_CONNECT_WEBHOOK_LISTENING=127.0.0.1:18193');
 console.log('RC128_LIVE_MONEY_MOVEMENT=DISABLED');
});
const timer=setInterval(()=>{void drain();},5000);
async function stop(){
 if(stopping)return;
 stopping=true;clearInterval(timer);
 server.close(()=>{void pool.end().then(()=>process.exit(0));});
}
process.on('SIGTERM',()=>{void stop();});
process.on('SIGINT',()=>{void stop();});
