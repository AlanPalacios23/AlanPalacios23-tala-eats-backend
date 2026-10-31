import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mayLinkSupportOrder} from '../dist/platform/support-order-access.js';

const order={userId:41,driverId:62,orderType:'delivery'};
const buyer={id:41,role:'customer'};
const driver={id:62,role:'driver'};
const outsider={id:99,role:'driver'};

test('RC153 order-linked ticket permissions are off by default for drivers',()=>{
 assert.equal(mayLinkSupportOrder(driver,order,false),false);
 assert.equal(mayLinkSupportOrder(outsider,order,false),false);
 assert.equal(mayLinkSupportOrder(buyer,order,false),true);
 assert.equal(mayLinkSupportOrder({id:2,role:'admin'},order,false),true);
});

test('RC153 driver access is scoped to actual assigned delivery',()=>{
 assert.equal(mayLinkSupportOrder(driver,order,true),true);
 assert.equal(mayLinkSupportOrder(outsider,order,true),false);
 assert.equal(mayLinkSupportOrder(driver,{...order,driverId:null},true),false);
 assert.equal(mayLinkSupportOrder(driver,{...order,driverId:88},true),false);
 assert.equal(mayLinkSupportOrder(driver,{...order,orderType:'pickup'},true),false);
 assert.equal(mayLinkSupportOrder({id:62,role:'restaurant'},order,true),false);
 assert.equal(mayLinkSupportOrder(driver,null,true),false);
 assert.equal(mayLinkSupportOrder({id:0,role:'admin'},order,true),false);
});

test('RC153 no role can link an unrelated customer order or elevate from guest',()=>{
 assert.equal(mayLinkSupportOrder({id:41,role:'driver'},{...order,driverId:99},false),true);
 assert.equal(mayLinkSupportOrder({id:41,role:'customer'},{...order,userId:100},true),false);
 assert.equal(mayLinkSupportOrder({id:41,role:'merchant'},{...order,userId:100},true),false);
 assert.equal(mayLinkSupportOrder({id:-1,role:'admin'},order,true),false);
});

test('RC153 capability is authenticated, no-store and gated on the backend',()=>{
 const root=new URL('../src/',import.meta.url);
 const routes=readFileSync(new URL('platform/routes.ts',root),'utf8');
 const config=readFileSync(new URL('config.ts',root),'utf8');
 assert.match(routes,/platformRouter.get\('\/support\/capabilities',async\(req,res\)=>\{/);
 assert.match(routes,/account\.role==='driver'&&config\.DRIVER_ORDER_SUPPORT_ENABLED==='true'/);
 assert.match(routes,/select:\{userId:true,driverId:true,orderType:true\}/);
 assert.match(routes,/mayLinkSupportOrder\(account,order,true\)/);
 assert.match(routes,/res\.setHeader\('Cache-Control','private, no-store'\)/);
 assert.match(routes,/user_id:row\.userId/);
 assert.match(config,/DRIVER_ORDER_SUPPORT_ENABLED: z\.enum\(\['false','true'\]\)\.default\('false'\)/);
});
