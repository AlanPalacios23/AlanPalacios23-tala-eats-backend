import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const source=readFileSync(new URL('../scripts/kali-stripe-live-credentials.py',import.meta.url),'utf8');
test('Kali LIVE installer is valid Python and does not print Stripe secrets',()=>{
 const result=spawnSync('python3',['-c','import ast,sys; ast.parse(sys.stdin.read())'],{
   input:source,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 assert.match(source,/getpass\.getpass/);
 assert.match(source,/os\.fchmod\(fd, 0o600\)/);
 assert.match(source,/os\.replace\(temporary_name, TARGET\)/);
 assert.doesNotMatch(source,/print\((?:secret|publishable|webhook)\)/);
});
test('LIVE credential installation cannot enable production charges or touch staging',()=>{
 assert.match(source,/"STRIPE_LIVE_ENABLED": "false"/);
 assert.match(source,/"STRIPE_LIVE_RELEASE_APPROVED": "false"/);
 assert.match(source,/"STRIPE_FINANCIAL_WRITES_ENABLED": "false"/);
 assert.match(source,/talaeats-node-live\.env/);
 assert.doesNotMatch(source,/talaeats-node-staging\.env/);
 assert.doesNotMatch(source,/pm2\s+(?:reload|restart|start)|docker\s+compose/i);
});
