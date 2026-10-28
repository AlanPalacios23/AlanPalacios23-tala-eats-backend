import { z } from 'zod';
import { config } from './config.js';
import { db } from './db.js';

// Transactional authentication mail. STAGING is allowlisted; LIVE is independently
// opt-in with an operator-approved Resend sender. No Stripe dependencies,
// no request-supplied recipient or URL, and no token/PII in logs.
// The outbox is protected by a PG row lock across the short provider request
// so multiple PM2 workers cannot send the same entry concurrently.
const live=config.NODE_ENV==='production';
const enabled=live
  ? config.LIVE_AUTH_EMAIL_DELIVERY_MODE==='resend'&&config.LIVE_AUTH_EMAIL_SENDER_APPROVED==='true'
  : config.STAGE_EMAIL_DELIVERY_MODE==='resend';
const apiKey=live?config.LIVE_AUTH_EMAIL_RESEND_API_KEY:config.STAGE_EMAIL_RESEND_API_KEY;
const sender=live?config.LIVE_AUTH_EMAIL_FROM:config.STAGE_EMAIL_FROM;
const allowed = new Set((config.STAGE_EMAIL_ALLOWED_RECIPIENTS ?? '')
  .split(',').map(s=>s.trim().toLowerCase()).filter(s=>z.email().safeParse(s).success));

async function transmit(id:number,email:string,subject:string,body:string):Promise<void>{
  const response=await fetch('https://api.resend.com/emails',{
    method:'POST',
    headers:{
      'Authorization':'Bearer '+apiKey!,
      'Content-Type':'application/json',
      'Idempotency-Key':(live?'tala-node-live-auth-email-':'tala-node-stage-email-')+id,
    },
    body:JSON.stringify({
      from:sender,
      to:[email],
      subject,
      text:body,
    }),
    signal:AbortSignal.timeout(9000),
  });
  if(!response.ok)throw new Error('MAIL_PROVIDER_HTTP_'+response.status);
}

export async function deliverAuthMailBatch():Promise<number>{
 if(!enabled)return 0;
 const expiry=new Date(Date.now()-25*60_000);
 // Purge expiring password links instead of mailing unusable credentials.
 await db.authEmailOutbox.updateMany({
  where:{status:'pending',createdAt:{lt:expiry},
   ...(live?{subject:'Restablece tu contraseña de Tala Eats'}:{})},
  data:{status:'expired',textBody:'[redacted: expired staging mail]'},
 });
 let completed=0;
 for(let i=0;i<8;i++){
  const consumed=await db.$transaction(async tx=>{
   const ids=await tx.$queryRaw<Array<{id:number}>>`
     SELECT id FROM email_outbox
     WHERE status='pending' AND attempts < 3
       AND (${live}::boolean = false OR subject = 'Restablece tu contraseña de Tala Eats')
     ORDER BY created_at, id
     FOR UPDATE SKIP LOCKED LIMIT 1
   `;
   if(ids.length===0)return false;
   const mail=await tx.authEmailOutbox.findUnique({where:{id:ids[0]!.id}});
   if(!mail)return false;
   if((!live&&!allowed.has(mail.toEmail.trim().toLowerCase()))||
      (live&&mail.subject!=='Restablece tu contraseña de Tala Eats')){
    await tx.authEmailOutbox.update({where:{id:mail.id},data:{
      status:'blocked',lastError:live?'LIVE_ONLY_PASSWORD_RECOVERY_EMAIL_ALLOWED':'STAGING_RECIPIENT_NOT_ALLOWED',
      textBody:'[redacted: unapproved recipient]',
    }});
    return true;
   }
   try{
    await transmit(mail.id,mail.toEmail,mail.subject,mail.textBody);
    await tx.authEmailOutbox.update({where:{id:mail.id},data:{
      status:'sent',attempts:{increment:1},sentAt:new Date(),
      lastError:'',textBody:'[redacted: email delivered]',
    }});
   }catch(error){
    const attempts=mail.attempts+1;
    const failure=error instanceof Error ? error.message : 'MAIL_PROVIDER_ERROR';
    await tx.authEmailOutbox.update({where:{id:mail.id},data:{
      attempts:{increment:1},
      status:attempts>=3?'failed':'pending',
      lastError:/^MAIL_PROVIDER_HTTP_[0-9]{3}$/.test(failure)?failure:'MAIL_PROVIDER_UNAVAILABLE',
      ...(attempts>=3 ? {textBody:'[redacted: mail failed]'} : {}),
    }});
   }
   return true;
  },{maxWait:3000,timeout:15000});
  if(!consumed)break;
  completed++;
 }
 return completed;
}

// Preserve the existing staging worker API for compatibility.
export const deliverStageMailBatch=deliverAuthMailBatch;
