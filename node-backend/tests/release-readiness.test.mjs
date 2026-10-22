import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const run=(script,...args)=>spawnSync(process.execPath,
  [path.join(root,'scripts',script),...args],{
   cwd:root,encoding:'utf8',timeout:10_000,
  });

test('Staging candidate has isolation and safety release gates',()=>{
 const result=run('release-readiness.mjs','--stage','--json');
 assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
 const status=JSON.parse(result.stdout);
 assert.equal(status.classification,'STAGE_CODE_GATE_PASS');
 assert.equal(status.productionReady,false);
 assert.ok(status.stageChecks.length>=8);
 assert.ok(status.stageChecks.every(x=>x.ok===true),result.stdout);
});
test('Production launch fails closed with explicit blockers',()=>{
 const result=run('release-readiness.mjs','--production','--json');
 assert.equal(result.status,1,result.stdout);
 const status=JSON.parse(result.stdout);
 assert.equal(status.classification,'PRODUCTION_NO_GO');
 assert.equal(status.deployPermitted,false);
 assert.equal(status.productionReady,false);
 assert.ok(status.blockers.some(x=>x.id==='stripe-finance'));
 assert.ok(status.blockers.some(x=>x.id==='end-to-end-delivery'));
});
test('Unknown release commands never enable production',()=>{
 const result=run('release-readiness.mjs','--go-live');
 assert.equal(result.status,2);
});
test('Read-only smoke cannot reach arbitrary hosts or production',()=>{
 for(const url of [
  'https://talaeats.alan-palacios-dev.com/api/v1',
  'http://192.168.1.1:18190/api/v1',
  'http://localhost:18190/api/v1',
  'https://api-stage-talaeats.alan-palacios-dev.com/api/v2',
  'https://api-stage-talaeats.alan-palacios-dev.com:8080/api/v1',
 ]){
  const result=run('stage-readonly-smoke.mjs',url);
  assert.equal(result.status,2,url+' '+result.stdout+result.stderr);
  assert.match(result.stderr,/ABORT_ONLY_KNOWN_STAGE_API_URL/);
 }
});
