/**
 * RC8 STRIPE LIVE: independent production-only guard.
 * This module does not start an API or accept payments. RC7 staging must never
 * import/instantiate this module as a runtime provider.
 */
export class LiveGateError extends Error {
  constructor(readonly reason:string) { super('LIVE_GATE_BLOCKED:'+reason); }
}
export type LiveSettings = {
  nodeEnv:string; explicitlyEnabled:string; key:string; publishableKey:string;
  webhookSecret:string; databaseUrl:string; redisUrl:string;
  refundsEnabled:string; transfersEnabled:string;
  maxOrderMinor:string; readinessApproved:string;
};
export type ValidatedLiveSettings = {
  secretKey:string; publishableKey:string; webhookSecret:string;
  maxOrderMinor:number; databaseUrl:string; redisUrl:string;
  refundsEnabled:boolean; transfersEnabled:false;
};
function assert(condition:unknown,reason:string):asserts condition {
  if(!condition)throw new LiveGateError(reason);
}
export function validateLiveSettings(raw:LiveSettings):ValidatedLiveSettings {
  assert(raw.nodeEnv==='production','NODE_ENV_NOT_PRODUCTION');
  assert(raw.explicitlyEnabled==='true','LIVE_EXPLICIT_OPT_IN_REQUIRED');
  assert(raw.readinessApproved==='true','RELEASE_SIGNOFF_REQUIRED');
  const prefix=['sk_','rk_'].find(p=>raw.key.startsWith(p+'live_'));
  const suffix=prefix?raw.key.slice((prefix+'live_').length):'';
  assert(Boolean(prefix)&&suffix.length>=16&&/^[A-Za-z0-9]+$/.test(suffix),
    'LIVE_RESTRICTED_OR_SECRET_KEY_REQUIRED');
  assert(/^pk_live_[A-Za-z0-9]{16,}$/.test(raw.publishableKey),'LIVE_PUBLISHABLE_KEY_REQUIRED');
  assert(/^whsec_[A-Za-z0-9]{16,}$/.test(raw.webhookSecret),'LIVE_WEBHOOK_SIGNATURE_REQUIRED');
  assert(raw.transfersEnabled==='false','CONNECT_TRANSFERS_UNIMPLEMENTED');
  // There is no audited refundable-money compensation handler yet.
  // Refusing to claim refunds are enabled prevents a false LIVE release.
  assert(raw.refundsEnabled==='false','LIVE_REFUND_COMPENSATION_NOT_IMPLEMENTED');
  const max=Number(raw.maxOrderMinor);
  assert(Number.isSafeInteger(max)&&max>=100&&max<=50_000,'PILOT_MAX_AMOUNT_INVALID');
  let db:URL,redis:URL;
  try{
    db=new URL(raw.databaseUrl);
    redis=new URL(raw.redisUrl);
  }catch{throw new LiveGateError('DATABASE_OR_REDIS_URL_INVALID');}
  assert(['postgres:','postgresql:'].includes(db.protocol)&&!!db.password&&
    !!db.username&&!!db.hostname,'POSTGRES_PRODUCTION_CREDENTIALS_REQUIRED');
  assert(['redis:','rediss:'].includes(redis.protocol)&&!!redis.password&&
    !!redis.hostname,'REDIS_PRODUCTION_CREDENTIALS_REQUIRED');
  // Guard the actual RC7 resources. A LIVE collection cannot ever reuse
  // the RC7 stage database, Redis port/DB, or stage client identity.
  assert(!(db.hostname==='127.0.0.1'&&db.port==='15435')&&
    db.pathname!=='/tala_node_stage'&&db.username!=='tala_node_stage',
    'STAGE_POSTGRES_REUSE_FORBIDDEN');
  assert(!(redis.hostname==='127.0.0.1'&&redis.port==='16379'&&
    (redis.pathname===''||redis.pathname==='/0')),
    'STAGE_REDIS_REUSE_FORBIDDEN');
  return {secretKey:raw.key,publishableKey:raw.publishableKey,
    webhookSecret:raw.webhookSecret,maxOrderMinor:max,
    databaseUrl:raw.databaseUrl,redisUrl:raw.redisUrl,
    refundsEnabled:false,transfersEnabled:false};
}
export function livePilotAmount(amount:number,maxAmountMinor:number):number {
  assert(Number.isSafeInteger(amount)&&amount>=100&&amount<=maxAmountMinor,
    'ORDER_AMOUNT_OUTSIDE_PILOT_LIMIT');
  return amount;
}
export const liveReceiptIdentity=(intent:{
  livemode:boolean;id:string;amount:number;amount_received:number;
  currency:string;status:string;metadata:Record<string,string>;
},order:{id:number;buyerId:number;amountMinor:number})=>{
  assert(intent.livemode,'TEST_OBJECT_IN_LIVE');
  assert(/^pi_[A-Za-z0-9]+$/.test(intent.id),'INVALID_PI');
  assert(intent.currency==='mxn'&&intent.amount===order.amountMinor,
    'AMOUNT_OR_CURRENCY_MISMATCH');
  assert(intent.metadata.tala_mode==='rc8_live_pickup'&&
    intent.metadata.order_id===String(order.id)&&
    intent.metadata.buyer_id===String(order.buyerId),'LIVE_ORDER_BINDING_MISMATCH');
  assert(intent.status==='succeeded'&&intent.amount_received===intent.amount,
    'CAPTURE_NOT_CONFIRMED');
  return true;
};
