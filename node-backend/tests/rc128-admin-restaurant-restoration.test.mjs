import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const routes=readFileSync(new URL('../src/operational/routes.ts',import.meta.url),'utf8');

test('admin restores archived or suspended only with MFA and a verified owner application',()=>{
 const start=routes.indexOf("adminRouter.patch('/restaurants/:restaurantId/restore'");
 const end=routes.indexOf("// \"Eliminar\" from the ADMIN UI",start);
 assert.ok(start>0 && end>start);
 const section=routes.slice(start,end);
 assert.match(section,/await account\(req,\['admin'\]\)/);
 assert.match(section,/\['archived','suspended'\]/);
 assert.match(section,/confirm_name/);
 assert.match(section,/shop\.name!==p\.confirm_name/);
 assert.match(section,/owner\.isActive/);
 assert.match(section,/owner\.role!=='restaurant'/);
 assert.match(section,/tx\.opsOnboarding\.findFirst/);
 assert.match(section,/status:'approved'/);
 assert.match(section,/restaurantId:id,status:\{notIn:\['delivered','cancelled'\]\}/);
 assert.match(section,/verificationStatus:'verified',onboardingStatus:'approved'/);
 assert.match(section,/isOpen:false,pickupEnabled:false,sponsored:false/);
 assert.match(section,/action:'restaurant\.restore'/);
 assert.match(section,/beforeJson:JSON\.stringify\(before\)/);
 assert.match(section,/afterJson:JSON\.stringify\(after\)/);
 assert.doesNotMatch(section,/stripe\.paymentIntents|stripe\.transfers|stripe\.payouts/);
 assert.doesNotMatch(section,/tx\.marketplaceMenuItem\.(create|delete|update)/);
});
