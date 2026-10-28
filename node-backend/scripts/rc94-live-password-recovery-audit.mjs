/**
 * Read-only LIVE recovery diagnostics. Does not fetch or log mail contents,
 * users, reset tokens, API keys, addresses, or Stripe credentials.
 */
import {config} from '../dist/config.js';
import {db} from '../dist/db.js';
const u=new URL(config.DATABASE_URL);
if(config.NODE_ENV!=='production'||u.hostname!=='127.0.0.1'||
  u.port!=='15445'||u.pathname!=='/tala_node_live')
 throw Error('RC94_AUDIT_ONLY_FOR_ATTESTED_LIVE');
try{
 const rows=await db.$queryRaw`
   SELECT status,COUNT(*)::int AS n,
          COALESCE(EXTRACT(EPOCH FROM NOW()-MIN(created_at)),0)::int AS age_seconds
   FROM email_outbox
   WHERE subject='Restablece tu contraseña de Tala Eats'
   GROUP BY status
 `;
 const states=new Map(rows.map(x=>[x.status,x]));
 const count=s=>states.get(s)?.n??0;
 const active=config.LIVE_AUTH_EMAIL_DELIVERY_MODE==='resend'&&
   config.LIVE_AUTH_EMAIL_SENDER_APPROVED==='true';
 console.log('RC94_AUTH_RECOVERY_LIVE=READ_ONLY');
 console.log('RC94_AUTH_EMAIL_CONFIG='+ (active?'ENABLED':'DISABLED'));
 console.log('RC94_AUTH_EMAIL_PENDING='+count('pending'));
 console.log('RC94_AUTH_EMAIL_PROVIDER_ACCEPTED='+count('sent'));
 console.log('RC94_AUTH_EMAIL_FAILED='+count('failed'));
 console.log('RC94_AUTH_EMAIL_EXPIRED='+count('expired'));
 console.log('RC94_OLDEST_PENDING_SECONDS='+(states.get('pending')?.age_seconds??0));
 console.log('RC94_STRIPE_MONEY_MOVEMENT=UNCHANGED');
 console.log('RC94_PROVIDER_INBOX_DELIVERY_NOT_ATTESTED=YES');
}finally{await db.$disconnect()}
