import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const s=readFileSync(new URL('../src/operational/routes.ts',import.meta.url),'utf8');
const p=readFileSync(new URL('../prisma/schema.prisma',import.meta.url),'utf8');
const m=readFileSync(new URL('../prisma/migrations/20261028_rc97_driver_plate_registration/migration.sql',import.meta.url),'utf8');

test('plate is validated by strict onboarding schema and returned only under authenticated onboarding routes',()=>{
 assert.match(s,/plate:z\.string\(\)\.trim\(\)\.max\(30\)/);
 assert.match(s,/plate:p\.entity_type==='driver'\?p\.plate\.toUpperCase\(\):''/);
 assert.match(s,/plate:o\.plate/);
 assert.match(s,/operationsRouter\.post\('\/onboarding',async\(req,res\)=>\{/);
});
test('ADMIN approval transfers plate from pending record to driver_profiles, not at signup',()=>{
 assert.match(s,/create:\{userId:account\.id,vehicle:old\.vehicle\|\|'Motocicleta',plate:old\.plate,isVerified:true\}/);
 assert.match(s,/update:\{vehicle:old\.vehicle\|\|'Motocicleta',plate:old\.plate,isVerified:true\}/);
 assert.match(p,/model OpsOnboarding \{[\s\S]*?plate String @default\(""\) @db\.VarChar\(30\)/);
 assert.match(m,/ADD COLUMN IF NOT EXISTS "plate" VARCHAR\(30\) NOT NULL DEFAULT ''/);
});
test('plate submission does not create payout, verified driver or alter live dispatch gate',()=>{
 const submit=s.split("operationsRouter.post('/onboarding'")[1]?.split("operationsRouter.get('/onboarding/mine'")[0]??'';
 assert.ok(!submit.includes('marketplaceDriverProfile.upsert'));
 assert.ok(!submit.includes('isVerified:true'));
});
