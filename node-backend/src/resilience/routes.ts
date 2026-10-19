// H2 isolated operational resilience. All routes require an ACTIVE ADMIN JWT.
// Financial reconciliation is read-only here; the Python PSP reconciliation
// and outbox publisher are NOT represented as live on the Node stage stack.
import { Router,type Request,type Response,type NextFunction } from 'express';
import { db } from '../db.js';
import { current } from '../auth/routes.js';
export const resilienceRouter=Router();
class StageResilienceError extends Error {
 constructor(public readonly http:number,message:string){super(message);}
}
const fail=(http:number,msg:string):never=>{throw new StageResilienceError(http,msg);};
async function admin(req:Request){
 const {user}=await current(req);
 if(user.role!=='admin')return fail(403,'Sin permisos de ADMIN');
 return user;
}
function id(req:Request,key:string){
 const p=req.params[key],s=Array.isArray(p)?p[0]:p;
 if(!s||!/^[1-9][0-9]*$/.test(s)||!Number.isSafeInteger(Number(s)))
  return fail(422,'Identificador inválido');
 return Number(s);
}
function limit(req:Request,def=100,max=500){
 const s=req.query.limit;
 if(s===undefined)return def;
 if(typeof s!=='string'||!/^[1-9][0-9]*$/.test(s))
  return fail(422,'Límite inválido');
 return Math.min(max,Number(s));
}
const date=(x:Date|null)=>x?.toISOString()??null;
const priv=(res:Response)=>res.setHeader('Cache-Control','private, no-store');
resilienceRouter.get('/status',async(req,res)=>{
 await admin(req);
 const [outbox,dead,dlq,wrong,alerts]=await Promise.all([
  db.stageEventOutbox.count({where:{status:{in:['pending','retry']}}}),
  db.stageEventOutbox.count({where:{status:'dead'}}),
  db.stageDeadLetterJob.count({where:{status:'open'}}),
  db.stagePaymentReconciliation.count({where:{status:'mismatch',
   createdAt:{gte:new Date(Date.now()-86400000)}}}),
  db.stageSystemAlert.count({where:{status:'open'}}),
 ]);
 priv(res);
 res.json({version:'1.4.0-core-resilience',implementation:'node-stage',
  state_machine:'node-prisma-transactions-stage',
  outbox:{pending:outbox,dead},dlq_open:dlq,
  payment_mismatches_24h:wrong,open_alerts:alerts,
  runtime:{sampled:false,window_requests:null,p95_ms:null},
  distributed_runtime:{available:false,reason:'not_instrumented'},
  circuit_breakers:{available:false,reason:'not_instrumented'}});
});
resilienceRouter.get('/alerts',async(req,res)=>{
 await admin(req);
 const rows=await db.stageSystemAlert.findMany({orderBy:{
  lastSeenAt:'desc'},take:limit(req)});
 priv(res);
 res.json(rows.map(x=>({id:x.id,key:x.alertKey,severity:x.severity,
  component:x.component,message:x.message,detail_json:x.detailJson,
  status:x.status,first_seen_at:x.firstSeenAt.toISOString(),
  last_seen_at:x.lastSeenAt.toISOString(),notified_at:date(x.notifiedAt)})));
});
resilienceRouter.get('/dlq',async(req,res)=>{
 await admin(req);
 const rows=await db.stageDeadLetterJob.findMany({
  orderBy:{createdAt:'desc'},take:limit(req)});
 priv(res);
 res.json(rows.map(x=>({id:x.id,source:x.source,source_id:x.sourceId,
  kind:x.kind,error:x.error,attempts:x.attempts,status:x.status,
  created_at:x.createdAt.toISOString()})));
});
resilienceRouter.post('/dlq/:dlqId/retry',async(req,res)=>{
 await admin(req);
 const dlqId=id(req,'dlqId');
 const queued=await db.$transaction(async tx=>{
  const locked=await tx.$queryRawUnsafe(
   'SELECT id FROM dead_letter_jobs WHERE id=$1 FOR UPDATE',dlqId);
  if(!Array.isArray(locked)||!locked.length)return fail(409,'DLQ no disponible');
  const original=await tx.stageDeadLetterJob.findUnique({where:{id:dlqId}});
  if(!original||original.status!=='open')return fail(409,'DLQ no disponible');
  let payload:Record<string,unknown>;
  try{payload=JSON.parse(original.payloadJson??'{}')}catch{
   return fail(409,'DLQ contiene carga inválida');}
  if(!payload||typeof payload!=='object'||Array.isArray(payload))
   return fail(409,'DLQ contiene carga inválida');
  const orderId=payload.order_id,aggregateId=
   typeof orderId==='number'||typeof orderId==='string'?
    String(orderId):original.sourceId;
  const x=await tx.stageEventOutbox.create({data:{
   eventKey:'dlq-retry:'+dlqId,
   aggregateType:/^(order|payment|driver)\./.test(original.kind)?'order':'system',
   aggregateId,eventType:original.kind,payloadJson:JSON.stringify(payload),
   status:'pending'}});
  await tx.stageDeadLetterJob.update({where:{id:dlqId},
   data:{status:'retried',resolvedAt:new Date()}});
  return x;
 },{maxWait:10000,timeout:15000});
 res.json({outbox_id:queued.id,status:queued.status});
});
resilienceRouter.post('/alerts/evaluate',async(req,res)=>{
 await admin(req);
 const [pending,mismatches]=await Promise.all([
  db.stageEventOutbox.count({where:{status:{in:['pending','retry']}}}),
  db.stagePaymentReconciliation.count({where:{status:'mismatch'}})]);
 let created=0,updated=0,resolved=0;
 for(const input of [
  {key:'node.stage.outbox_backlog',active:pending>=100,
   message:'Event outbox supera 100 pendientes',value:pending,component:'outbox'},
  {key:'node.stage.payment_mismatch',active:mismatches>0,
   message:'Diferencias de conciliación requieren revisión',value:mismatches,
   component:'payments'},
 ]){
  await db.$transaction(async tx=>{
   await tx.$queryRawUnsafe(
    'SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtext($1))',input.key);
   const existing=await tx.stageSystemAlert.findFirst({
    where:{alertKey:input.key,status:'open'}});
   if(input.active){
    if(existing){
     await tx.stageSystemAlert.update({where:{id:existing.id},data:{
      lastSeenAt:new Date(),detailJson:JSON.stringify({observed:input.value})}});
     updated++;
    }else{
     await tx.stageSystemAlert.create({data:{alertKey:input.key,
      severity:input.component==='payments'?'critical':'warning',
      component:input.component,message:input.message,
      detailJson:JSON.stringify({observed:input.value})}});
     created++;
    }
   }else if(existing){
    await tx.stageSystemAlert.update({where:{id:existing.id},
     data:{status:'resolved',resolvedAt:new Date(),lastSeenAt:new Date()}});
    resolved++;
   }
  },{maxWait:10000,timeout:15000});
 }
 res.json({created,updated,resolved,notifications_sent:0,
  provider:'node-stage-internal-only'});
});
resilienceRouter.get('/ledger/balance',async(req,res)=>{
 await admin(req);
 const records=await db.stageFinancialLedgerEntry.findMany({
  select:{account:true,direction:true,amount:true},take:100000});
 const sums=new Map<string,bigint>();
 for(const x of records){
  const [whole,frac='']=x.amount.toFixed(2).split('.');
  const cents=BigInt(whole!)*100n+BigInt((frac+'00').slice(0,2));
  const current=sums.get(x.account)??0n;
  sums.set(x.account,current+(x.direction==='credit'?cents:-cents));
 }
 const balances:Record<string,string>={};
 for(const [k,v] of sums){
  const n=v<0n?-v:v;
  balances[k]=(v<0n?'-':'')+(n/100n)+'.'+(n%100n).toString().padStart(2,'0');
 }
 priv(res);
 res.json({append_only:true,balances,read_rows:records.length,
  sample_limited:records.length>=100000});
});
resilienceRouter.get('/slo',async(req,res)=>{
 await admin(req);
 const pending=await db.stageEventOutbox.count({where:{
  status:{in:['pending','retry']}}});
 priv(res);
 res.json({healthy:false,window_requests:null,
  error_rate_percent:null,error_rate_threshold_percent:5,
  p95_ms:null,p95_threshold_ms:1200,
  outbox_backlog:pending,outbox_backlog_threshold:100,
  metrics_sampled:false,reason:'Node stage lacks production runtime sampler'});
});
resilienceRouter.get('/infrastructure',async(req,res)=>{
 await admin(req);
 priv(res);
 res.json({read_replica_configured:false,postgis_configured:false,
  postgis_available:false,pitr_configured:false,otel_configured:false,
  immutable_ledger:true,stage_only:true});
});
resilienceRouter.post('/retention/run',async(req,res)=>{
 await admin(req);
 const n=limit(req,2000,5000);
 const ago=new Date(Date.now()-90*86400000);
 const done=await db.$transaction(async tx=>{
  const oldAlerts=await tx.stageSystemAlert.findMany({
   where:{status:'resolved',resolvedAt:{lt:ago}},
   select:{id:true},take:n});
  const delAlerts=oldAlerts.length?await tx.stageSystemAlert.deleteMany({
   where:{id:{in:oldAlerts.map(x=>x.id)}}}):{count:0};
  const oldDlq=await tx.stageDeadLetterJob.findMany({
   where:{status:'retried',resolvedAt:{lt:ago}},select:{id:true},
   take:Math.max(0,n-delAlerts.count)});
  const delDlq=oldDlq.length?await tx.stageDeadLetterJob.deleteMany({
   where:{id:{in:oldDlq.map(x=>x.id)}}}):{count:0};
  return {alerts:delAlerts.count,dlq:delDlq.count};
 });
 res.json({deleted_alerts:done.alerts,deleted_dlq:done.dlq,
  deleted_financial_records:0,limit:n});
});
export function resilienceErrors(err:unknown,_req:Request,res:Response,next:NextFunction){
 if(err instanceof StageResilienceError){
  res.status(err.http).json({detail:err.message});return;
 }
 next(err);
}
