import test from 'node:test';
import assert from 'node:assert/strict';
import {deliveryDistance,assertRestaurantDeliveryOrigin}
 from '../dist/marketplace/delivery-geography.js';
const origin={lat:20.65,lng:-103.71};
test('RC8.7 geodistance is server-calculated with milli-km rounding',()=>{
 const d=deliveryDistance(origin,{lat:20.66,lng:-103.71},5);
 assert.ok(d.distanceKm>=1.11&&d.distanceKm<=1.113);
 assert.equal(Number(d.distanceMilliKm)/1000,d.distanceKm);
 assert.equal(deliveryDistance(origin,origin,5).distanceKm,0);
});
test('RC8.7 denies radius bypass, NaN, zero defaults and nonverified restaurants',()=>{
 assert.throws(()=>deliveryDistance(origin,{lat:20.9,lng:-103.71},4),/radio/);
 assert.throws(()=>deliveryDistance(origin,{lat:99,lng:-103.71},4),/Coordenadas/);
 assert.throws(()=>deliveryDistance(origin,{lat:0,lng:0},4),/Coordenadas/);
 assert.throws(()=>deliveryDistance(origin,{lat:20.65,lng:-103.71},200),/radio/);
 assert.throws(()=>assertRestaurantDeliveryOrigin({lat:20.6534,lng:-103.704},'Tala'),/verificada/);
 assert.throws(()=>assertRestaurantDeliveryOrigin(origin,' '),/verificada/);
 assert.doesNotThrow(()=>assertRestaurantDeliveryOrigin(origin,'Tala, Jalisco'));
});
