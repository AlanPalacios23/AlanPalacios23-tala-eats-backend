/**
 * RC9 LIVE withdrawal readiness. READ-ONLY; no DB updates or Stripe POSTs.
 * Operates on the existing LIVE config, not on sandbox/staging credentials.
 * Prints aggregate counts and actionable BLOCKERS, never PII or bank numbers.
 *
 * Usage: node --env-file=$HOME/.config/talaeats-node-live.env \
 *   scripts/rc9-live-withdrawal-activation-audit.mjs
 */
import Stripe from 'stripe';
import pg from 'pg';
import {config} from '../dist/config.js';

const stop=(code)=>{console.log('RC9_ACTIVATION_HOLD='+code);process.exitCode=1;};
const expected='acct_1UB69APUp8Tz0qUa';
if(config.NODE_ENV!=='production'||config.HOST!=='127.0.0.1'||
   config.PORT!==18190||config.STRIPE_PLATFORM_ACCOUNT_ID!==expected||
   config.STRIPE_CONNECT_TRANSFERS_ENABLED!=='false'||
   config.STRIPE_SECRET_KEY?.startsWith('sk_test_')||
   config.TREASURY_CONNECT_WEBHOOK_INGEST_ENABLED!=='false'){
 console.log('RC9_ACTIVATION_ABORT=EXACT_LIVE_READ_ONLY_CONTEXT_REQUIRED');
 process.exit(1);
}
const u=new URL(config.DATABASE_URL);
if(u.hostname!=='127.0.0.1'||u.port!=='15445'||u.pathname!=='/tala_node_live'){
 console.log('RC9_ACTIVATION_ABORT=NOT_VERIFIED_PRODUCTION_DATABASE');
 process.exit(1);
}
const pool=new pg.Pool({connectionString:config.DATABASE_URL,connectionTimeoutMillis:5000,max:1,statement_timeout:12000});
const stripe=new Stripe(config.STRIPE_SECRET_KEY,{maxNetworkRetries:0,timeout:7500});
let db;
try {
 const client=await pool.connect();
 try{
  await client.query('BEGIN READ ONLY');
  const identity=await client.query('SELECT current_database() AS db,inet_server_port() AS port');
  if(identity.rows[0]?.db!=='tala_node_live'||identity.rows[0]?.port!==15445)
   throw Error('PRODUCTION_DATABASE_IDENTITY_MISMATCH');
  const counts=await client.query(
   "SELECT (SELECT count(*)::int FROM tala_live_merchant_accounts) AS merchants,"+
   " (SELECT count(*)::int FROM tala_live_driver_accounts) AS drivers,"+
   " (SELECT count(*)::int FROM users WHERE role='admin' AND is_active AND two_factor_enabled AND totp_secret IS NOT NULL) AS admins,"+
   " (SELECT count(*)::int FROM tala_live_financial_cases WHERE status<>'resolved') AS cases,"+
   " (SELECT count(*)::int FROM tala_live_treasury_transfers WHERE state='completed') AS completed_transfers,"+
   " (SELECT count(*)::int FROM tala_live_treasury_transfers WHERE state IN ('reserved','submitted','unknown','manual_hold')) AS held_transfers,"+
   " (SELECT count(*)::int FROM tala_live_treasury_withdrawals WHERE state IN ('reserved','submitted','unknown','review_required')) AS pending_withdrawals,"+
   " (SELECT count(*)::int FROM tala_live_treasury_events WHERE state<>'processed') AS pending_events,"+
   " (SELECT count(*)::int FROM tala_live_treasury_ledger) AS payout_receipts"
  );
  const merchant=await client.query(
   "SELECT m.stripe_account_id AS account, m.owner_approved_at IS NOT NULL AS approved,"+
   " u.is_active AS active, u.role AS role FROM tala_live_merchant_accounts m"+
   " JOIN restaurants r ON r.id=m.restaurant_id JOIN users u ON u.id=r.owner_id ORDER BY m.restaurant_id"
  );
  const driver=await client.query(
   "SELECT d.stripe_account_id AS account,d.owner_approved_at IS NOT NULL AS approved,"+
   " u.is_active AS active,u.role AS role,p.is_verified AS verified"+
   " FROM tala_live_driver_accounts d JOIN users u ON u.id=d.user_id"+
   " JOIN driver_profiles p ON p.user_id=d.user_id ORDER BY d.user_id"
  );
  await client.query('COMMIT');
  db={counts:counts.rows[0],merchant:merchant.rows,driver:driver.rows};
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}
 finally{client.release();}
 console.log('RC9_LIVE_DATABASE_READ_ONLY=PASS');
 for(const key of ['merchants','drivers','admins','cases','completed_transfers','held_transfers','pending_withdrawals','pending_events','payout_receipts']){
  console.log('RC9_DB_'+key.toUpperCase()+'='+db.counts[key]);
 }
 const accounts=[];
 let cursor;
 for(let page=0;page<10;page++){
  const res=await stripe.accounts.list({limit:100,...(cursor?{starting_after:cursor}:{})});
  accounts.push(...res.data);
  if(!res.has_more)break;
  if(page===9||res.data.length===0)throw Error('CONNECT_ACCOUNT_PAGINATION_INCOMPLETE');
  cursor=res.data.at(-1).id;
 }
 const remote=new Map(accounts.map(a=>[a.id,a]));
 console.log('RC9_STRIPE_LIVE_CONNECTED_ACCOUNTS='+accounts.length);
 const webhooks=await stripe.webhookEndpoints.list({limit:100});
 if(webhooks.has_more)stop('WEBHOOK_ENDPOINT_PAGINATION_INCOMPLETE');
 const connectWebhook=webhooks.data.find(w=>
  w.url==='https://talaeats.alan-palacios-dev.com/api/v1/webhooks/stripe-connect'&&
  w.status==='enabled'&&w.connect===true&&
  ['payout.created','payout.updated','payout.paid','payout.failed','payout.canceled']
   .every(t=>w.enabled_events.includes(t)));
 console.log('RC9_SIGNED_CONNECT_PAYOUT_WEBHOOK='+Boolean(connectWebhook));
 if(!connectWebhook)stop('MISSING_CONNECT_PAYOUT_SIGNED_EVENTS');

 const payees=[
  ...db.merchant.map(x=>({...x,kind:'restaurant'})),
  ...db.driver.map(x=>({...x,kind:'driver'}))
 ];
 if(new Set(payees.map(x=>x.account)).size!==payees.length)stop('DUPLICATE_CONNECT_PAYEE');
 const unique=payees.filter(x=>typeof x.account==='string'&&remote.has(x.account));
 const statistics={restaurant:{registered:db.merchant.length,approved:0,bank_verified:0,manual_ready:0},
  driver:{registered:db.driver.length,approved:0,bank_verified:0,manual_ready:0}};
 for(const p of payees){
  const s=statistics[p.kind],acct=remote.get(p.account);
  const approved=p.approved===true&&p.active===true&&
   p.role===p.kind&&(p.kind!=='driver'||p.verified===true);
  if(approved)s.approved++;
  const capabilities=acct?.capabilities?.transfers==='active'&&acct?.payouts_enabled===true&&
    acct?.details_submitted===true&&!acct?.requirements?.disabled_reason&&
    (acct?.requirements?.currently_due?.length??0)===0&&
    (acct?.requirements?.past_due?.length??0)===0;
  let bankVerified=false;
  if(acct){
   const banks=await stripe.accounts.listExternalAccounts(acct.id,{object:'bank_account',limit:100});
   const defaults=banks.data.filter(b=>b.object==='bank_account'&&b.country==='MX'&&
     b.currency==='mxn'&&b.default_for_currency===true);
   bankVerified=!banks.has_more&&defaults.length===1&&
    ['new','verified'].includes(defaults[0].status)&&
    acct.payouts_enabled===true&&acct.details_submitted===true&&
    !acct.requirements?.disabled_reason;
  }
  if(approved&&bankVerified)s.bank_verified++;
  if(approved&&capabilities&&bankVerified&&acct?.settings?.payouts?.schedule?.interval==='manual')
   s.manual_ready++;
 }
 for(const [kind,stat] of Object.entries(statistics)){
  console.log('RC9_'+kind.toUpperCase()+'_CONNECT_REGISTERED='+stat.registered);
  console.log('RC9_'+kind.toUpperCase()+'_OWNER_APPROVED='+stat.approved);
  console.log('RC9_'+kind.toUpperCase()+'_BANK_PAYOUT_ELIGIBLE='+stat.bank_verified);
  console.log('RC9_'+kind.toUpperCase()+'_MANUAL_PAYOUT_READY='+stat.manual_ready);
 }
 if(accounts.length!==unique.length)stop('STRIPE_ACCOUNT_NOT_UNIQUELY_MAPPED_TO_PAYEE');
 if(statistics.restaurant.manual_ready<1)stop('NO_APPROVED_RESTAURANT_WITH_MANUAL_CONNECT');
 if(statistics.driver.manual_ready<1)stop('NO_APPROVED_DRIVER_WITH_MANUAL_CONNECT');
 if(db.counts.admins<2)stop('TWO_DISTINCT_MFA_ADMINS_REQUIRED');
 if(db.counts.cases>0)stop('UNRESOLVED_REFUND_OR_DISPUTE');
 if(db.counts.held_transfers>0)stop('UNRESOLVED_TRANSFER_RESERVATIONS');
 if(db.counts.pending_withdrawals>0||db.counts.pending_events>0)
  stop('UNRECONCILED_WITHDRAWAL_OR_CONNECT_EVENT');
 if(db.counts.completed_transfers===0)stop('NO_RECONCILED_FUNDS_FOR_WITHDRAWAL');
 const priorTransfers=await stripe.transfers.list({limit:100});
 if(priorTransfers.has_more)stop('PROVIDER_TRANSFER_PAGINATION_REQUIRED');
 const unverifiable=priorTransfers.data.filter(t=>!t.source_transaction).length;
 console.log('RC9_STRIPE_TRANSFERS_WITHOUT_SOURCE_TRANSACTION='+unverifiable);
 if(unverifiable>0)console.log('RC9_LEGACY_TRANSFERS_REQUIRE_MANUAL_RECONCILIATION=YES');
 if(db.counts.payout_receipts===0)console.log('RC9_FIRST_SIGNED_BANK_PAYOUT_STILL_UNPROVEN=YES');
 // Transfer/Payout executors MUST NOT be unlocked by this read-only audit.
 console.log('RC9_TREASURY_SOURCE_EXECUTION_LOCKED=YES');
 console.log('RC9_LIVE_PAYOUT_ACTIVATED=NO');
} catch {
 console.log('RC9_ACTIVATION_AUDIT=HOLD_READ_ONLY_QUERY_OR_PROVIDER_FAILED');
 process.exitCode=1;
} finally {
 await pool.end();
}
