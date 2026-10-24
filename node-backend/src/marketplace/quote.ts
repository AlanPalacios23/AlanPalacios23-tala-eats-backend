/**
 * Server-derived, READ-ONLY pickup price preview for Tala Eats Usuarios.
 * Never reserves inventory, creates an order or authorizes a PaymentIntent.
 * Checkout revalidates stock, merchant availability and commercial settings.
 * Delivery is deliberately unsupported until a server-side distance quote,
 * allocation and real driver dispatch are available.
 */
import {calculateDefaultCommercial,fmtCents,type FinancialPolicy,type Tender} from '../finance/pricing.js';

export class PickupQuoteError extends Error {
  constructor(readonly code:number,message:string){super(message);}
}

export type PickupCatalogRow = {
  id:number; restaurantId:number; name:string; price:string;
  stock:number; isAvailable:boolean; optionsJson:string;
  priceScheduleJson:string; availabilityScheduleJson:string;
};
export type PickupQuoteItem = {menu_item_id:number;quantity:number;options?:string};
const money=/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/;
function minor(value:string):bigint {
  if(!money.test(value))throw new PickupQuoteError(422,'Importe no válido');
  const [pesos,decimals='']=value.split('.');
  return BigInt(pesos!)*100n+BigInt((decimals+'00').slice(0,2));
}
function basisPoints(value:string):bigint {
  const trimmed=value.trim();
  if(!/^(?:0|[1-9]\d?)(?:\.\d{1,4})?$/.test(trimmed))
    throw new PickupQuoteError(503,'Política comercial personalizada no compatible');
  const [whole,decimal='']=trimmed.split('.');
  return BigInt(whole!)*10000n+BigInt((decimal+'0000').slice(0,4));
}
export function assertDefaultPickupRates(
  rows:readonly {key:string;value:string}[],policy:FinancialPolicy,
):void {
  for(const row of rows) {
    let expected:bigint|null=null;
    if(row.key==='commercial_v152.restaurant_commission_rate')expected=1500n;
    if(policy==='v152'&&row.key==='commercial_v152.service_fee_rate')expected=700n;
    if(policy==='v162'&&row.key==='commercial_v162.service_fee_rate')expected=700n;
    // Cap of MXN 25 is expressed as 25.0000 in legacy settings and
    // uses the identical fixed-point representation in checkout.ts.
    if(policy==='v162'&&row.key==='commercial_v162.service_fee_cap')expected=250000n;
    if(expected!==null&&basisPoints(row.value)!==expected)
      throw new PickupQuoteError(503,'Política comercial diferente del checkout');
  }
}
export function calculatePickupQuoteFromCatalog(input:{
  restaurantId:number;items:readonly PickupQuoteItem[];
  catalog:readonly PickupCatalogRow[];tip:string;
  method:Tender;policy:FinancialPolicy;
}){
  if(!Number.isSafeInteger(input.restaurantId)||input.restaurantId<=0||
     !['cash','stripe'].includes(input.method)||
     !['v152','v162'].includes(input.policy)||
     input.items.length<1||input.items.length>100)
    throw new PickupQuoteError(422,'Cotización no válida');
  const tip=minor(input.tip);
  if(tip>1_000_000n)throw new PickupQuoteError(422,'Propina fuera de límite');
  const catalog=new Map(input.catalog.map(item=>[item.id,item]));
  const sums=new Map<number,number>();
  const items=[] as {
    menu_item_id:number;quantity:number;unit_price:string;line_total:string;
  }[];
  let subtotal=0n;
  for(const line of input.items) {
    if(!Number.isSafeInteger(line.menu_item_id)||line.menu_item_id<=0||
       !Number.isSafeInteger(line.quantity)||line.quantity<1||
       line.quantity>50|| (line.options??'')!=='')
      throw new PickupQuoteError(422,'Producto, cantidad u opciones no válidos');
    const sum=(sums.get(line.menu_item_id)??0)+line.quantity;
    if(sum>50)throw new PickupQuoteError(422,'Cantidad excedida para un producto');
    sums.set(line.menu_item_id,sum);
    const row=catalog.get(line.menu_item_id);
    if(!row||row.restaurantId!==input.restaurantId)
      throw new PickupQuoteError(400,'Producto no pertenece al restaurante');
    if(!row.isAvailable||row.stock<sum)
      throw new PickupQuoteError(409,'Producto no disponible o sin stock');
    if(row.priceScheduleJson.trim()!=='{}'||
       row.availabilityScheduleJson.trim()!=='{}'||
       row.optionsJson.trim()!=='[]')
      throw new PickupQuoteError(503,'Producto con opciones o programación no admitidas');
    const unit=minor(row.price);
    if(unit<=0n)throw new PickupQuoteError(503,'Precio no válido');
    const amount=unit*BigInt(line.quantity);
    subtotal+=amount;
    items.push({menu_item_id:line.menu_item_id,quantity:line.quantity,
      unit_price:fmtCents(unit),line_total:fmtCents(amount)});
  }
  if(subtotal>9_999_999_999n)
    throw new PickupQuoteError(422,'Subtotal fuera de límite');
  const economics=calculateDefaultCommercial({
    policy:input.policy,method:input.method,fulfillment:'pickup',
    subtotal,discount:0n,tip,
  });
  return {
    currency:'MXN',order_type:'pickup',payment_method:input.method,
    commercial_pricing_version:input.policy==='v162'?'1.6.2':'1.5.2',
    restaurant_id:input.restaurantId,items,
    subtotal:fmtCents(subtotal),discount:'0.00',
    service_fee:fmtCents(economics.serviceFee),
    delivery_fee:'0.00',tip:fmtCents(tip),
    total:fmtCents(economics.total),
    quote_is_binding:false,inventory_reserved:false,
    requires_revalidation_on_order:true,
    delivery_checkout_supported:false,
  };
}
