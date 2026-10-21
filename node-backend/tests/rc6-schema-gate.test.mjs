import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const gate=path.join(root,'scripts/rc6-schema-gate.mjs');
const script=path.join(root,'scripts/kali-rc6-release-plan.sh');
test('RC6 migrations and deploy requirements are exactly reviewed',()=>{
 const r=spawnSync(process.execPath,[gate,'--check'],{encoding:'utf8',cwd:root});
 assert.equal(r.status,0,r.stdout+'\n'+r.stderr);
 assert.match(r.stdout,/RC6_SCHEMA_CODE_GATE=PASS/);
 assert.match(r.stdout,/RC6_PRODUCTION_CUTOVER=NOT_AUTHORIZED/);
});
test('RC6 release gate refuses unknown mode',()=>{
 const r=spawnSync(process.execPath,[gate,'--production'],{encoding:'utf8',cwd:root});
 assert.equal(r.status,2);
});
test('Kali RC6 plan fails closed for non-stage local CI identity',()=>{
 const r=spawnSync('bash',[script,'--plan','a'.repeat(40)],{encoding:'utf8',cwd:root});
 assert.equal(r.status,1);
 assert.match(r.stdout,/ABORT_STAGE_USER_ONLY/);
});
test('Kali RC6 plan rejects absent or shortened SHA',()=>{
 const r=spawnSync('bash',[script,'--plan','deadbeef'],{encoding:'utf8',cwd:root});
 assert.equal(r.status,2);
 assert.match(r.stdout,/USAGE/);
});
test('RC6 plan script passes Bash syntax',()=>{
 const r=spawnSync('bash',['-n',script],{encoding:'utf8',cwd:root});
 assert.equal(r.status,0,r.stderr);
});
