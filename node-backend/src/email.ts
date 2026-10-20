import { z } from 'zod';
import { config } from './config.js';
import { db } from './db.js';

// Staging-only restricted transactional mail. No payment credentials, no
// arbitrary recipient or URL, and no recovery token is ever written to logs.
// The outbox is protected by a PG row lock across the short provider request
// so multiple PM2 workers cannot send the same entry concurrently.
const allowed = new Set((config.STAGE_EMAIL_ALLOWED_RECIPIENTS ?? '')
  .split(',').map(s=>s.trim().toLowerCase()).filter(s=>z.email().safeParse(s).success));

async function transmit(id:number,email:string,subject:string,body:string):Promise<void>{
  const response=await fetch('https://api.resend.com/emails',{
    method:'POST',
    headers:{
      'Authorization':'Bearer '+config.STAGE_EMAIL_RESEND_API_KEY!,
      'Content-Type':'application/json',
      'Idempotency-Key':'tala-node-stage-email-'+id,
    },
    body:JSON.stringify({
      from:config.STAGE_EMAIL_FROM,
      to:[email],
      subject,
      text:body,
    }),
    signal:AbortSignal.timeout(9000),
  });
  if(!response.ok)throw new Error('MAIL_PROVIDER_HTTP_'+response.status);
}

export async function deliverStageMailBatch():Promise<number>{
 if(config.STAGE_EMAIL_DELIVERY_MODE!=='resend')return 0;
 const expiry=new Date(Date.now()-25*60_000);
 // Purge expiring password links instead of mailing unusable credentials.
 await db.authEmailOutbox.updateMany({
  where:{status:'pending',createdAt:{lt:expiry}},
  data:{status:'expired',textBody:'[redacted: expired staging mail]'},
 });
 let completed=0;
 for(let i=0;i<8;i++){
  const consumed=await db.$transaction(async tx=>{
   const ids=await tx.$queryRaw<Array<{id:number}>>`
     SELECT id FROM email_outbox
     WHERE status='pending' AND attempts < 3
     ORDER BY created_at, id
     FOR UPDATE SKIP LOCKED LIMIT 1
   `;
   if(ids.length===0)return false;
   const mail=await tx.authEmailOutbox.findUnique({where:{id:ids[0]!.id}});
   if(!mail)return false;
   if(!allowed.has(mail.toEmail.trim().toLowerCase())){
    await tx.authEmailOutbox.update({where:{id:mail.id},data:{
      status:'blocked',lastError:'STAGING_RECIPIENT_NOT_ALLOWED',
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
