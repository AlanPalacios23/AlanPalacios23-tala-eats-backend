import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('Connect account ID cannot be assigned to both driver and restaurant even concurrently',()=>{
 const sql=readFileSync(new URL('../prisma/migrations/20261024_rc86_exclusive_connect_recipients/migration.sql',import.meta.url),'utf8');
 assert.match(sql,/CREATE OR REPLACE FUNCTION tala_rc86_exclusive_connect_recipient/);
 assert.match(sql,/pg_advisory_xact_lock\(hashtextextended/);
 assert.match(sql,/TG_TABLE_NAME='tala_live_merchant_accounts'/);
 assert.match(sql,/TG_TABLE_NAME='tala_live_driver_accounts'/);
 assert.match(sql,/CREATE TRIGGER tala_rc86_merchant_connect_exclusive/);
 assert.match(sql,/CREATE TRIGGER tala_rc86_driver_connect_exclusive/);
 assert.match(sql,/RC86_EXISTING_CROSS_ROLE_CONNECT_COLLISION/);
 assert.match(sql,/FOREIGN KEY \(order_id\) REFERENCES orders\(id\)/);
 assert.doesNotMatch(sql,/\.transfers\.create|UPDATE\s+orders\s+SET/i);
});
test('Kali source prepare must be fail-closed with zero financial activity',()=>{
 const source=readFileSync(new URL('../scripts/rc86-kali-readonly-preflight.mjs',import.meta.url),'utf8');
 const sh=readFileSync(new URL('../scripts/rc86-kali-prepare.sh',import.meta.url),'utf8');
 assert.match(source,/20261024_rc86_exclusive_connect_recipients/);
 assert.match(source,/SOURCE_SHA_MISMATCH/);
 assert.match(source,/PREPARATION_REQUIRES_LIVE_CHARGES_OFF/);
 assert.match(source,/PRIVATE_LIVE_ENV_PERMISSIONS_INVALID/);
 assert.match(source,/STRIPE_CONNECT_TRANSFERS_ENABLED/);
 assert.match(sh,/npm run db:validate/);
 assert.match(sh,/npm run build/);
 assert.match(sh,/npm test/);
 assert.doesNotMatch(sh,/pm2\s+(restart|reload|start)|prisma\s+migrate\s+deploy|stripe\.transfers\.create/i);
});
