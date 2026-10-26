/** Node RC8 Web Push sender. Disabled by default and isolated from Stripe/finance. */
import webpush from 'web-push';
import {db} from '../db.js';
import {config} from '../config.js';
import {PROMOTIONAL_PUSH_KINDS,safeNotificationPath,validPushEndpoint} from './web-push-policy.js';
export {validPushEndpoint} from './web-push-policy.js';

const MAX_ATTEMPTS=5;
export function webPushConfigured():boolean {
 return config.WEB_PUSH_ENABLED==='true'&&Boolean(config.WEB_PUSH_VAPID_PUBLIC_KEY&&
  config.WEB_PUSH_VAPID_PRIVATE_KEY&&config.WEB_PUSH_SUBJECT);
}
function retryAt(attempts:number):Date {
 return new Date(Date.now()+Math.min(30*60_000,30_000*2**Math.max(0,attempts-1)));
}
export async function deliverWebPushIteration(batch=20):Promise<{sent:number;failed:number;suppressed:number}>{
 if(!webPushConfigured())return {sent:0,failed:0,suppressed:0};
 const since=new Date(Date.now()-2*60*60*1000);
 const notices=await db.authNotification.findMany({
  where:{createdAt:{gte:since}},
  orderBy:{createdAt:'desc'},take:Math.max(100,Math.min(1000,batch*10)),
  select:{id:true,userId:true,createdAt:true,kind:true,title:true,message:true}
 });
 if(!notices.length)return {sent:0,failed:0,suppressed:0};
 const users=await db.authUser.findMany({
  where:{id:{in:[...new Set(notices.map(n=>n.userId))]}},
  select:{id:true,role:true,isActive:true,marketingOptIn:true}
 });
 const allowed=new Map(users.map(u=>[u.id,u]));
 const subscriptions=await db.stagePushSubscription.findMany({
  where:{active:true,platform:'web',userId:{in:users.map(u=>u.id)}},
  take:1000
 });
 let sent=0,failed=0,suppressed=0,claimedCount=0;
 for(const note of notices){
  if(claimedCount>=batch)break;
  const account=allowed.get(note.userId);
  if(!account||account.role!=='customer'||!account.isActive)continue;
  for(const sub of subscriptions.filter(s=>s.userId===note.userId&&
   note.createdAt>=sub.createdAt&&note.createdAt>=sub.updatedAt)){
   if(!validPushEndpoint(sub.endpoint)){
    await db.stagePushSubscription.updateMany({where:{id:sub.id},data:{active:false}});
    continue;
   }
   const existing=await db.stageWebPushDelivery.upsert({
    where:{uq_web_push_pair:{notificationId:note.id,subscriptionId:sub.id}},
    create:{notificationId:note.id,subscriptionId:sub.id},
    update:{},
   });
   if(existing.status==='sent'||existing.status==='suppressed'||existing.status==='expired'||
      existing.attempts>=MAX_ATTEMPTS)continue;
   const now=new Date();
   const claimed=await db.stageWebPushDelivery.updateMany({
    where:{id:existing.id,status:{in:['pending','retry','sending']},
     attempts:{lt:MAX_ATTEMPTS},nextAttemptAt:{lte:now},
     OR:[{claimUntil:null},{claimUntil:{lt:now}}]},
    data:{status:'sending',attempts:{increment:1},
     claimUntil:new Date(now.getTime()+60_000)}
   });
   if(!claimed.count)continue;
   claimedCount++;
   const attempt=existing.attempts+1;
   if(PROMOTIONAL_PUSH_KINDS.has(note.kind)&&!account.marketingOptIn){
    await db.stageWebPushDelivery.update({where:{id:existing.id},
     data:{status:'suppressed',claimUntil:null,lastError:'marketing-no-consent'}});
    suppressed++;continue;
   }
   try{
    if(!sub.p256dh||!sub.auth)throw Error('invalid-keys');
    await webpush.sendNotification({endpoint:sub.endpoint,keys:{p256dh:sub.p256dh,auth:sub.auth}},
     JSON.stringify({title:note.title.slice(0,90),body:note.message.slice(0,240),
      url:safeNotificationPath(note.kind,note.message),tag:'tala-notice-'+note.id}),
     {vapidDetails:{subject:config.WEB_PUSH_SUBJECT!,publicKey:config.WEB_PUSH_VAPID_PUBLIC_KEY!,
       privateKey:config.WEB_PUSH_VAPID_PRIVATE_KEY!},TTL:7200,timeout:8000,urgency:'normal'});
    await db.stageWebPushDelivery.update({where:{id:existing.id},
     data:{status:'sent',sentAt:new Date(),claimUntil:null,lastError:''}});
    sent++;
   }catch(error:unknown){
    const status=typeof error==='object'&&error!==null&&'statusCode'in error?
     Number(error.statusCode):0;
    const gone=status===404||status===410;
    if(gone)await db.stagePushSubscription.updateMany({where:{id:sub.id},data:{active:false}});
    await db.stageWebPushDelivery.update({where:{id:existing.id},data:{
     status:gone?'expired':attempt>=MAX_ATTEMPTS?'failed':'retry',
     lastError:gone?'provider-expired':'delivery-failed',
     claimUntil:null,nextAttemptAt:retryAt(attempt)
    }});
    failed++;
   }
  }
 }
 return {sent,failed,suppressed};
}
