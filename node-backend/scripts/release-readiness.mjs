#!/usr/bin/env node
// TALA EATS Node.js release classification. This is NOT a production enable
// switch. Fail closed until the separate LIVE architecture and E2E flows exist.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=new Set(process.argv.slice(2));
if([...args].some(x=>!['--stage','--production','--json'].includes(x)) ||
   Number(args.has('--stage'))+Number(args.has('--production'))!==1) {
 console.error('USAGE: node scripts/release-readiness.mjs --stage|--production [--json]');
 process.exit(2);
}
const read=(p)=>readFileSync(path.join(root,p),'utf8');
const config=read('src/config.ts');
const app=read('src/app.ts');
const checkout=read('src/marketplace/checkout.ts');
const driver=read('src/marketplace/driver.ts');
const worker=read('src/worker.ts');
const webhook=read('src/webhook.ts');
const auth=read('src/auth/routes.ts');
const stripe=read('src/stripe.ts');
const market=read('src/marketplace/routes.ts');
const resilience=read('src/resilience/routes.ts');
const versions=read('src/versions/routes.ts');
const media=read('src/parity/routes.ts');
const files=[
 'src/server.ts','src/app.ts','src/worker.ts','src/config.ts',
 'prisma/schema.prisma','ecosystem.config.cjs',
 'scripts/actualizar.sh',
];
const stageChecks=[
 {id:'isolated-runtime',ok:config.includes("config.NODE_ENV==='staging'") &&
     config.includes('STAGING_MONEY_WRITES_FORBIDDEN')&&
     /HOST:\s*z\.literal\('127\.0\.0\.1'\)/.test(config),
  detail:'Runtime restringido al proceso staging local'},
 {id:'isolated-postgres-redis',ok:config.includes('STAGING_POSTGRES_ISOLATION_REQUIRED')&&
     config.includes('STAGING_REDIS_ISOLATION_REQUIRED'),
  detail:'PostgreSQL y Redis privados, separados del Python productivo'},
 {id:'stripe-live-disabled',ok:config.includes('STAGING_MONEY_WRITES_FORBIDDEN')&&
     config.includes('STAGING_REQUIRES_STRIPE_TEST_KEY')&&
     config.includes('STAGING_REQUIRES_STRIPE_TEST_PUBLISHABLE')&&
     stripe.includes("startsWith('sk_test_')")===false,
  detail:'En staging se rechazan claves LIVE y escrituras financieras'},
 {id:'explicit-stage-ready',ok:app.includes("const live=config.NODE_ENV==='production'?")&&
     app.includes("environment:live?'production':'staging'")&&
     app.includes('financialWrites:Boolean(live&&ready)')&&
     app.includes('online_payment_writes:Boolean(live)'),
  detail:'Readiness de staging separado de la aptitud financiera LIVE'},
 {id:'worker-heartbeat',ok:app.includes('workerHeartbeat')===false &&
     app.includes("tala:node:stage:worker:heartbeat") &&
     worker.includes("workerHeartbeatTimer"),
  detail:'Visibilidad del worker PM2 por TTL'},
 {id:'admin-mfa-across-roles',
  ok:market.includes("session.user.twoFactorEnabled || !session.mfaVerified") &&
     resilience.includes("!user.twoFactorEnabled||!mfaVerified"),
  detail:'Los pedidos ajenos y el diagnóstico requieren TOTP ADMIN'},
 {id:'runtime-worker-key',
  ok:versions.includes("tala:node:stage:worker:heartbeat") &&
     !versions.includes("talaeats:worker:heartbeat"),
  detail:'Diagnóstico V10 consulta el heartbeat PM2 real'},
 {id:'multipart-exact-closure',
  ok:media.includes("tail!==close&&tail!==close+'\\r\\n'"),
  detail:'Archivos malformados se rechazan después del cierre multipart'},
 {id:'checkout-narrow',ok:checkout.includes("STAGE_PICKUP_CASH_CHECKOUT_ENABLED")&&
     checkout.includes("order_type:z.literal('pickup')"),
  detail:'Checkout experimental limitado a efectivo/recoger'},
 {id:'driver-synthetic-only',ok:driver.includes('stage_driver_fixture')&&
     driver.includes('STAGE_DRIVER_DELIVERY_ENABLED'),
  detail:'Entregas reales no habilitadas por error'},
 {id:'mail-stage-restricted',ok:auth.includes("STAGE_EMAIL_DELIVERY_MODE")&&
     config.includes('STAGE_EMAIL_ALLOWED_RECIPIENTS'),
  detail:'Recuperación de contraseña sin correo ficticio'},
 {id:'webhook-test-only',ok:webhook.includes('event.livemode')&&
     webhook.includes('live_event_forbidden'),
  detail:'Webhook rechaza eventos LIVE'},
 {id:'required-release-files',ok:files.every(p=>existsSync(path.join(root,p))),
  detail:'Código y rollback manual presentes'},
];
const blockers=[
 {id:'live-runtime',detail:'Se necesita runtime de producción separado, secretos auditados y configuración validada; éste es exclusivo de staging'},
 {id:'stripe-finance',detail:'Faltan cobros Stripe, confirmación por webhooks idempotentes, reembolsos, conciliación y liquidaciones LIVE probadas'},
 {id:'end-to-end-delivery',detail:'Repartidor sólo procesa fixtures sintéticos; faltan pedidos delivery reales, despacho y pruebas de compensación'},
 {id:'recovery-and-mfa',detail:'Verificar correo real de recuperación, App Links y MFA ADMIN en todo el backend'},
 {id:'mobile-contracts',detail:'Faltan flujos reales de punta a punta con Usuarios, Restaurante, Repartidor y portal ADMIN'},
 {id:'realtime-and-support',detail:'Verificar conexión WebSocket, soporte, aprobaciones y rutas de Cloudflare para producción'},
 {id:'backup-restore-security',detail:'Backup/restauración de producción, prueba de rollback, observabilidad, seguridad y aprobación del corte de tráfico'},
];
const failed=stageChecks.filter(c=>!c.ok);
const production=args.has('--production');
const report={
 classification:production?'PRODUCTION_NO_GO':failed.length?'STAGE_BLOCKED':'STAGE_CODE_GATE_PASS',
 deployPermitted:!production&&failed.length===0,
 productionReady:false,
 stageChecks,blockers,
 note:'El gate de código no reemplaza pruebas de API, aprobación de migraciones, verificación del host Kali ni revisión financiera.',
};
if(args.has('--json'))console.log(JSON.stringify(report,null,2));
else{
 console.log('TALA_NODE_RELEASE_CLASSIFICATION='+report.classification);
 for(const item of stageChecks)console.log('GATE_'+item.id+'='+(item.ok?'PASS':'FAIL'));
 if(production){
  for(const item of blockers)console.log('PRODUCTION_BLOCKER_'+item.id+'='+item.detail);
 }
 console.log('PRODUCTION_READY=NO');
}
if(production||failed.length)process.exitCode=1;
