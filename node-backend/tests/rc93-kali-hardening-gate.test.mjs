import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const paths=[
 'rc93-kali-prepare-release.sh',
 'rc93-kali-live-connect-otp-migration.sh',
 'rc93-kali-hardening-two-pm2-cutover.sh',
];
const data=paths.map(x=>readFileSync(new URL('../scripts/'+x,import.meta.url),'utf8'));
test('RC93 Kali scripts are bash-valid and protected from unapproved money movement',()=>{
 for(let i=0;i<paths.length;i++){
  const result=spawnSync('bash',['-n',new URL('../scripts/'+paths[i],import.meta.url).pathname],{encoding:'utf8'});
  assert.equal(result.status,0,paths[i]+': '+result.stderr);
  assert.doesNotMatch(data[i],/stripe\.(?:payouts|transfers|charges)\.create\(|DROP TABLE|DROP DATABASE|prisma migrate reset/);
 }
 assert.match(data[0],/8f4ea97c23ae8372d171f277f5615c719beed240/);
 assert.match(data[1],/I_APPROVE_RC93_BANK_TOTP_SCHEMA_ONLY/);
 assert.match(data[1],/I_VERIFIED_RC93_FRESH_RESTORE_AND_SHADOW_MIGRATION/);
 assert.match(data[1],/connect_otp_one_use_per_user_step/);
 assert.match(data[1],/NOT_EXACTLY_TREASURY_PENDING|NOT_EXACTLY_TREASURY_PENDING|NOT_EXACTLY_TREASURY_PENDING/);
 assert.match(data[2],/rc93-kali-live-connect-otp-migration.sh --verify/);
 assert.match(data[2],/I_APPROVE_RC93_BACKEND_HARDENING_PM2_ONLY/);
 assert.match(data[2],/RC93_CUTOVER_ROLLBACK/);
});
test('RC93 refuses random account/unapproved apply',()=>{
 for(const p of paths){
  const r=spawnSync('bash',[new URL('../scripts/'+p,import.meta.url).pathname,'--apply','0'.repeat(40)],
   {encoding:'utf8',env:{HOME:'/tmp',PATH:'/usr/bin:/bin'}});
  assert.notEqual(r.status,0);
  assert.match(r.stdout+r.stderr,/RC93_|USAGE:/);
 }
});
