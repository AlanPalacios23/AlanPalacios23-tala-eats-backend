import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calculatePickupQuoteFromCatalog,assertDefaultPickupRates}
  from '../dist/marketplace/quote.js';

const catalog=[
 {id:11,restaurantId:7,name:'Taco',price:'50.00',stock:20,
  isAvailable:true,optionsJson:'[]',priceScheduleJson:'{}',
  availabilityScheduleJson:'{}'},
 {id:12,restaurantId:7,name:'Agua',price:'25.50',stock:10,
  isAvailable:true,optionsJson:'[]',priceScheduleJson:'{}',
  availabilityScheduleJson:'{}'},
];
const quote=(x={})=>calculatePickupQuoteFromCatalog({
 restaurantId:7,method:'cash',policy:'v162',tip:'10.00',
 items:[{menu_item_id:11,quantity:2},{menu_item_id:12,quantity:1}],
 catalog,...x,
});
test('pickup quote uses catalog prices, server commercial fees and no shipment',()=>{
 const x=quote();
 assert.equal(x.subtotal,'125.50');
 assert.equal(x.service_fee,'8.79');
 assert.equal(x.delivery_fee,'0.00');
 assert.equal(x.tip,'10.00');
 assert.equal(x.total,'144.29');
 assert.equal(x.items[0].line_total,'100.00');
 assert.equal(x.quote_is_binding,false);
 assert.equal(x.inventory_reserved,false);
 assert.equal(x.delivery_checkout_supported,false);
});
test('v162 caps 7 percent customer service fee at MXN 25',()=>{
 const x=quote({tip:'0',items:[{menu_item_id:11,quantity:10}]});
 assert.equal(x.subtotal,'500.00');
 assert.equal(x.service_fee,'25.00');
 assert.equal(x.total,'525.00');
});
test('v152 service fee does not cap and card method does not change customer total',()=>{
 const x=quote({policy:'v152',method:'stripe',tip:'0',
  items:[{menu_item_id:11,quantity:10}]});
 assert.equal(x.service_fee,'35.00');
 assert.equal(x.total,'535.00');
});
test('no invented quote for another restaurant or unavailable inventory',()=>{
 assert.throws(()=>quote({restaurantId:22}),/no pertenece/);
 assert.throws(()=>quote({catalog:[{...catalog[0],stock:1},catalog[1]]}),/stock/);
 assert.throws(()=>quote({catalog:[{...catalog[0],stock:100},catalog[1]],
  items:[{menu_item_id:11,quantity:40},
   {menu_item_id:11,quantity:11}]}),/Cantidad excedida/);
});
test('dynamic options and malicious line values fail closed',()=>{
 assert.throws(()=>quote({catalog:[{...catalog[0],optionsJson:'[{}]'},catalog[1]]}),
  /opciones/);
 assert.throws(()=>quote({tip:'-1'}),/Importe no válido/);
 assert.throws(()=>quote({tip:'1.001'}),/Importe no válido/);
 assert.throws(()=>quote({items:[{menu_item_id:11,quantity:1,options:'queso'}]}),
  /no válidos/);
});
test('custom financial settings rejected identically to order creation',()=>{
 assert.doesNotThrow(()=>assertDefaultPickupRates([
  {key:'commercial_v152.restaurant_commission_rate',value:'0.1500'},
  {key:'commercial_v162.service_fee_rate',value:'0.0700'},
  {key:'commercial_v162.service_fee_cap',value:'25.0000'},
 ],'v162'));
 assert.throws(()=>assertDefaultPickupRates([
  {key:'commercial_v162.service_fee_rate',value:'0.0900'},
 ],'v162'),/diferente/);
});
