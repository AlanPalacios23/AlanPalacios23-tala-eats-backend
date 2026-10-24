/**
 * RC8.7 geographic contract for LIMITED staging cash delivery.
 * Distance is the great-circle radius, not a road-routing promise.
 * Server owns both restaurant origin and customer's submitted coordinates.
 * Round UP to 0.001 km so tiny fractions never understate tariff mileage.
 */
export class DeliveryGeoError extends Error {
  constructor(readonly code:number,message:string){super(message);}
}
export type GeoPoint={lat:number;lng:number};
const valid=(x:GeoPoint):boolean=>Number.isFinite(x.lat)&&Number.isFinite(x.lng)&&
  Math.abs(x.lat)<=90&&Math.abs(x.lng)<=180&&
  !(x.lat===0&&x.lng===0);
export function deliveryDistance(origin:GeoPoint,destination:GeoPoint,
  radiusKm:number):{distanceKm:number;distanceMilliKm:bigint}{
  if(!valid(origin)||!valid(destination)||!Number.isFinite(radiusKm)||
     radiusKm<0.2||radiusKm>40)
    throw new DeliveryGeoError(422,'Coordenadas o radio de servicio inválidos');
  const rad=Math.PI/180;
  const dlat=(destination.lat-origin.lat)*rad,dlng=(destination.lng-origin.lng)*rad;
  const a=Math.min(1,Math.sin(dlat/2)**2+
    Math.cos(origin.lat*rad)*Math.cos(destination.lat*rad)*Math.sin(dlng/2)**2);
  const distance=6371.0088*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
  const millimetric=Math.max(0,Math.ceil(distance*1000-1e-10));
  if(!Number.isSafeInteger(millimetric)||millimetric<0||
     millimetric>Math.floor(radiusKm*1000+1e-8))
    throw new DeliveryGeoError(409,'Dirección fuera del radio de reparto');
  return {distanceKm:millimetric/1000,distanceMilliKm:BigInt(millimetric)};
}
/** Deliberately deny seeded restaurant coordinates without a verified origin. */
export function assertRestaurantDeliveryOrigin(origin:GeoPoint,address:string):void {
  if(!address.trim()||address.length>300||
    (origin.lat===20.6534&&origin.lng===-103.704)||
    !valid(origin))
    throw new DeliveryGeoError(503,'Restaurante sin ubicación geográfica verificada');
}
