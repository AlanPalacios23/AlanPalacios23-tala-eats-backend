// Read-only report before accepting the FIRST real pickup order.
// Run within the EXISTING LIVE release as tala-node-stage and pass LIVE .env.
// No Stripe API, payment object, DB write, sessions, tokens, bank data or PII.
import pg from 'pg';
const env=process.env;
const url=new URL(env.DATABASE_URL||'');
if(env.NODE_ENV!=='production'||!['127.0.0.1','localhost'].includes(url.hostname)||
  url.port!=='15445'||url.pathname==='/tala_node_stage'||
  url.pathname===''||!url.username||!url.password){
 console.error('PICKUP_AUDIT_HOLD=NOT_PRODUCTION_DATABASE');
 process.exit(1);
}
const client=new pg.Client({connectionString:env.DATABASE_URL,connectionTimeoutMillis:3000,
 statement_timeout:7000});
try{
 await client.connect();
 await client.query('BEGIN TRANSACTION READ ONLY');
 const identity=(await client.query(
  "SELECT current_database() AS db,pg_is_in_recovery() AS standby")).rows[0];
 if(identity.db!=='tala_node_live'||identity.standby){
  throw Error('DATABASE_IDENTITY_NOT_LIVE');
 }
 const res=await client.query(`
  SELECT r.id,r.name,r.verification_status,r.onboarding_status,
  r.is_open,r.pickup_enabled,(r.owner_id IS NOT NULL) AS owner_exists,
  COALESCE(u.is_active,FALSE) AS owner_active,
  (m.stripe_account_id IS NOT NULL) AS connect_mapped,
  (m.owner_approved_at IS NOT NULL) AS connect_owner_approved,
  count(mi.id) FILTER (WHERE mi.is_available=TRUE AND mi.stock>0)::int AS menu_ready_items
  FROM restaurants r
  LEFT JOIN users u ON u.id=r.owner_id
  LEFT JOIN tala_live_merchant_accounts m ON m.restaurant_id=r.id
  LEFT JOIN menu_items mi ON mi.restaurant_id=r.id
  GROUP BY r.id,u.is_active,m.stripe_account_id,m.owner_approved_at
  ORDER BY r.id LIMIT 50
 `);
 await client.query('ROLLBACK');
 const mapped=res.rows.filter(x=>x.connect_owner_approved);
 console.log('PICKUP_LIVE_READ_ONLY_AUDIT=PASS');
 console.log('PICKUP_LIVE_STRIPE_FINANCIAL_WRITES='+env.STRIPE_FINANCIAL_WRITES_ENABLED);
 console.log('PICKUP_LIVE_CASH_FLAG='+env.STAGE_PICKUP_CASH_CHECKOUT_ENABLED);
 console.log('PICKUP_RESTAURANT_ROWS='+res.rows.length);
 console.log('PICKUP_OWNER_APPROVED_MAPPINGS='+mapped.length);
 for(const x of res.rows){
  const label=String(x.name).slice(0,90).replace(/[\r\n\t]/g,' ');
  console.log(JSON.stringify({restaurant_id:x.id,name:label,
   verified:x.verification_status==='verified',
   onboarding_approved:x.onboarding_status==='approved',
   open:x.is_open,pickup:x.pickup_enabled,
   real_owner:x.owner_exists&&x.owner_active,
   connect_mapped:x.connect_mapped,
   connect_owner_approved:x.connect_owner_approved,
   menu_ready_items:x.menu_ready_items}));
 }
 console.log('PICKUP_AUDIT_NO_WRITES_OR_CHARGES=YES');
}catch(error){
 console.error('PICKUP_AUDIT_HOLD='+String(error?.message||'UNKNOWN')
  .replace(/[^A-Za-z0-9_]/g,'_').slice(0,80));
 process.exitCode=1;
}finally{await client.end().catch(()=>{});}
