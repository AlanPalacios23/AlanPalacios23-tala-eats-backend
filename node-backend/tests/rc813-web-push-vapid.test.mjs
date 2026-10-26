import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {validPushEndpoint,safeNotificationPath,PROMOTIONAL_PUSH_KINDS} from '../dist/operational/web-push-policy.js';

const read=p=>readFileSync(fileURLToPath(new URL(p,import.meta.url)),'utf8');

test('web push endpoint allowlist rejects browser-to-internal SSRF and counterfeit providers',()=>{
 const valid=[
  'https://fcm.googleapis.com/fcm/send/example',
  'https://web.push.apple.com/QABC',
  'https://updates.push.services.mozilla.com/wpush/v2/test',
  'https://foo.notify.windows.com/?token=abc'
 ];
 for(const url of valid)assert.equal(validPushEndpoint(url),true,url);
 for(const url of [
  'http://fcm.googleapis.com/fcm/send/test','https://127.0.0.1/internal',
  'https://169.254.169.254/latest/meta-data',
  'https://fcm.googleapis.com.evil.example/fake',
  'https://user:pass@fcm.googleapis.com/secret','https://fcm.googleapis.com:8443/fake',
  'file:///etc/passwd','https://[::1]/','not-a-url',
 ]){
  assert.equal(validPushEndpoint(url),false,url);
 }
});
test('notification link cannot route arbitrary texts to customer orders',()=>{
 assert.equal(safeNotificationPath('order','Tu pedido #184 está listo'),'/pedidos/184');
 assert.equal(safeNotificationPath('payment','Pago del pedido #9'),'/pedidos/9');
 assert.equal(safeNotificationPath('promo','Oferta pedido #184'),'/notificaciones');
 assert.equal(safeNotificationPath('account','Actualización de seguridad'),'/notificaciones');
 assert.equal(PROMOTIONAL_PUSH_KINDS.has('promo'),true);
});
test('delivery architecture is opt-in and does not change Stripe/financial mutations',()=>{
 const code=read('../src/operational/web-push.ts');
 const live=read('../src/live/production-worker.ts');
 const stage=read('../src/worker.ts');
 const cfg=read('../src/config.ts');
 const schema=read('../prisma/schema.prisma');
 const migrations=read('../prisma/migrations/20261026043000_web_push_delivery/migration.sql');
 const route=read('../src/versions/routes.ts');
 assert.ok(cfg.includes("WEB_PUSH_ENABLED: z.enum(['false','true']).default('false')"));
 assert.ok(code.includes('webpush.sendNotification'));
 assert.ok(code.includes("status:gone?'expired'"));
 assert.ok(code.includes('PROMOTIONAL_PUSH_KINDS.has(note.kind)&&!account.marketingOptIn'));
 assert.ok(code.includes('stageWebPushDelivery.upsert'));
 assert.ok(code.includes('await db.stageWebPushDelivery.count({where:{id:-1}})'), 'no heartbeat without delivery table');
 assert.ok(stage.includes('STAGE_WEB_PUSH_WORKER_HOLD'));
 assert.ok(live.includes('LIVE_WEB_PUSH_WORKER_HOLD'));
 assert.ok(live.includes('rc8WorkerIteration'));
 assert.ok(schema.includes('model StageWebPushDelivery'));
 assert.ok(migrations.includes('CREATE UNIQUE INDEX'));
 assert.ok(!migrations.includes('stripe'));
 assert.ok(route.includes("v11Router.get('/push/config'"));
 assert.ok(route.includes('webPushConfigured()&&worker'));
 assert.ok(route.includes("if(!validPushEndpoint(p.endpoint))"));
});

test('stage bootstrap pins a known CI commit and cannot apply DB migrations or PM2',()=>{
 const script=read('../scripts/rc813-web-push-prepare-kali.sh');
 const file=fileURLToPath(new URL('../scripts/rc813-web-push-prepare-kali.sh',import.meta.url));
 const result=spawnSync('bash',['-n',file],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 assert.ok(script.includes("SHA='398b531c4778a03975f30470f6979a38b9c8bb62'"));
 assert.ok(script.includes('bash "$RUNNER" --prepare "$SHA"'));
 assert.ok(script.includes('bash "$RUNNER" --plan "$SHA"'));
 assert.ok(script.includes('PUSH_STAGE_PRISMA_PLAN=HOLD_REVIEW_MIGRATIONS_AND_STAGE_DATA'));
 assert.ok(script.includes('PRIVATE_PARALLEL_STAGE_ENV=VALID'));
 assert.ok(script.includes('ISOLATED_PM2_DIRECTORY=ABSENT'));
 assert.ok(!script.includes('prisma migrate deploy'));
 assert.ok(!script.includes('pm2 start'));
 assert.ok(!script.includes('bash "$RUNNER" --apply'));
});
