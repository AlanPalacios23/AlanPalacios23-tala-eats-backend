import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const file=new URL('../scripts/rc91-kali-prepare-release.sh',import.meta.url);
const source=readFileSync(file,'utf8');
test('RC9.1 candidate preparation pins currently running RC9 without touching live money',()=>{
 const s=spawnSync('bash',['-n',file.pathname],{encoding:'utf8'});
 assert.equal(s.status,0,s.stderr);
 for(const expected of ['561c842c583940f5b01f650c8dbe3c26a770d85f','RC91_PRODUCTION_RUNTIME=UNCHANGED','RC91_DATABASE_SCHEMA=UNCHANGED','RC91_WITHDRAWALS_LIVE=OFF','npm test'])assert.ok(source.includes(expected),expected);
 assert.doesNotMatch(source,/pm2 (?:start|stop|restart|reload|delete)|prisma migrate deploy|stripe\.transfers\.create/);
});
test('RC9.1 candidate prepare does not run as arbitrary account',()=>{
 const r=spawnSync('bash',[file.pathname,'--plan','0'.repeat(40)],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:'/tmp'}});
 assert.notEqual(r.status,0);
 assert.match(r.stdout+r.stderr,/RC91_ABORT/);
});
