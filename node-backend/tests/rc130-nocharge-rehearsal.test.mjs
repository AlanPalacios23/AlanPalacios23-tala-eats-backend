import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  applyRehearsalAction,demoMoney,publicDemoRoom,RehearsalError,
} from '../dist/operational/rehearsal-machine.js';

const src=p=>readFileSync(new URL('../src/'+p,import.meta.url),'utf8');
function room(){
 return {id:'11111111-1111-4111-8111-111111111111',version:0,
  adminId:1,customerId:2,restaurantId:3,driverId:4,status:'new',
  productName:null,quantity:0,unitPriceMinor:0,
  paymentMethod:null,deliveryPin:'5321',
  createdAt:'2026-10-29T12:00:00.000Z',updatedAt:'2026-10-29T12:00:00.000Z'};
}
const at='2026-10-29T12:00:01.000Z';
test('RC13.0 full three-actor order lifecycle ends with PIN and demo-only wallet',()=>{
 let s=room();
 const moves=[
  ['customer','place',{productName:'Hamburguesa demo',quantity:2,
    unitPriceMinor:10000,paymentMethod:'card_demo'},'placed'],
  ['restaurant','accept',{},'accepted'],
  ['restaurant','prepare',{},'preparing'],
  ['restaurant','ready',{},'ready'],
  ['driver','assign',{},'assigned'],
  ['driver','pickup',{},'picked_up'],
  ['driver','depart',{},'on_the_way'],
  ['driver','deliver',{pin:'5321',expectedPin:'5321'},'delivered'],
 ];
 for(const [actor,action,details,status] of moves){
  s=applyRehearsalAction(s,actor,action,at,details);
  assert.equal(s.status,status);
 }
 assert.equal(s.version,8);
 const money=demoMoney(s);
 assert.equal(money.total_minor,25300);
 assert.equal(money.total_minor,
  money.merchant_minor+money.driver_minor+money.platform_minor);
 const view=publicDemoRoom(s,'customer');
 assert.equal(view.payment_charged,false);
 assert.equal(view.withdrawable,false);
 assert.equal(view.bank_balance_minor,0);
 assert.equal(view.money.merchant_demo_wallet_minor,17000);
 assert.equal(view.money.driver_demo_wallet_minor,3200);
 assert.equal(view.mock_payment_status,'simulated_not_charged');
 assert.throws(()=>applyRehearsalAction(s,'driver','deliver',at,
  {pin:'5321',expectedPin:'5321'}),RehearsalError);
});
test('RC13.0 only customer sees PIN; other actors cannot advance prematurely',()=>{
 let s=room();
 assert.equal('delivery_pin' in publicDemoRoom(s,'driver'),false);
 assert.equal('delivery_pin' in publicDemoRoom(s,'restaurant'),false);
 assert.equal(publicDemoRoom(s,'customer').delivery_pin,'5321');
 assert.throws(()=>applyRehearsalAction(s,'driver','assign',at),RehearsalError);
 assert.throws(()=>applyRehearsalAction(s,'restaurant','place',at,{}),RehearsalError);
 s=applyRehearsalAction(s,'customer','place',at,
  {productName:'Tacos demo',quantity:1,unitPriceMinor:2000,paymentMethod:'cash_demo'});
 assert.equal(publicDemoRoom(s,'customer').money.merchant_demo_wallet_minor,0);
 assert.throws(()=>applyRehearsalAction(s,'driver','pickup',at),RehearsalError);
 const cancelled=applyRehearsalAction(s,'admin','cancel',at);
 assert.equal(cancelled.status,'cancelled');
 assert.equal(demoMoney(cancelled).total_minor,0);
 assert.throws(()=>applyRehearsalAction(cancelled,'restaurant','accept',at),
  RehearsalError);
});
test('RC13.0 no financial LIVE integration and opt-in only',()=>{
 const config=src('config.ts'),app=src('app.ts');
 const api=src('operational/rehearsal-routes.ts');
 assert.match(config,/LIVE_DEMO_REHEARSAL_ENABLED: z\.enum\(\['false','true'\]\)\.default\('false'\)/);
 assert.match(app,/buildRehearsalRouter\(live\.redis\)/);
 assert.match(api,/DEMO_ADMIN_MFA_REQUIRED/);
 assert.match(api,/DEMO_PARTICIPANTS_MUST_BE_DISTINCT/);
 assert.match(api,/DEMO_CREATION_RATE_LIMITED/);
 assert.doesNotMatch(api,/\b(Stripe|stripe|PaymentIntent|tala_live_treasury|marketOrder\.create)\s*\(/);
 assert.match(api,/const PREFIX='tala:node:live:rehearsal:rc130:'/);
});
