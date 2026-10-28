import assert from 'node:assert/strict';
import {db} from '../dist/db.js';
import {deliverAuthMailBatch} from '../dist/email.js';
import {config} from '../dist/config.js';
if(config.NODE_ENV!=='staging'||config.STAGE_EMAIL_DELIVERY_MODE!=='resend'||
 process.env.CI!=='true')throw Error('RC94_MAIL_MOCK_STAGE_ONLY');
const allowed='rc94-inbox@example.com',blocked='rc94-not-allowed@example.com';
let called=0;
globalThis.fetch=async(url,request)=>{
 assert.equal(url,'https://api.resend.com/emails');
 assert.equal(request.method,'POST');
 assert.equal(request.headers['Authorization'],'Bearer '+config.STAGE_EMAIL_RESEND_API_KEY);
 assert.match(request.headers['Idempotency-Key'],/^tala-node-stage-email-\d+$/);
 const body=JSON.parse(request.body);
 assert.equal(body.to[0],allowed);
 assert.equal(body.from,config.STAGE_EMAIL_FROM);
 called++;
 return new Response(JSON.stringify({id:'email_test_1'}),{status:200});
};
try{
 await db.authEmailOutbox.createMany({data:[
  {toEmail:allowed,subject:'Restablece tu contraseña de Tala Eats',
   textBody:'Test only: no real reset token'},
  {toEmail:blocked,subject:'Restablece tu contraseña de Tala Eats',
   textBody:'Do not send'},
 ]});
 await deliverAuthMailBatch();
 assert.equal(called,1,'Only allowlisted staging recipient may reach provider');
 const rows=await db.authEmailOutbox.findMany({where:{toEmail:{in:[allowed,blocked]}},
  select:{toEmail:true,status:true,textBody:true}});
 assert.equal(rows.find(x=>x.toEmail===allowed)?.status,'sent');
 assert.equal(rows.find(x=>x.toEmail===blocked)?.status,'blocked');
 assert.ok(rows.every(x=>x.textBody.startsWith('[redacted:')));
 console.log('RC94_STAGE_PROVIDER_MOCK_OUTBOX=PASS');
}finally{await db.$disconnect()}
