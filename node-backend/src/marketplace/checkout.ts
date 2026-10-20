// TALA EATS Node stage ONLY. Narrow cash/pickup slice of Python orders.py.
// NOT a public checkout: does not support delivery, online providers, wallet,
// coupons, commercial setting overrides, scheduled menus or financial payouts.
import { createHmac, timingSafeEqual, randomInt } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db.js';
import { config } from '../config.js';
import type { AuthUser } from '../generated/prisma/client.js';

class CheckoutError extends Error {
  constructor(public readonly code:number, message:string){super(message);}
}
const positiveId=z.number().int().positive().safe();
const price=z.union([z.string(),z.number()]).transform(String)
  .pipe(z.string().regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/));
const intentSchema=z.strictObject({
  restaurant_id:positiveId,
  address:z.string().trim().min(3).max(300),
  notes:z.string().trim().max(1000).default(''),
  payment_method:z.literal('cash'),
  order_type:z.literal('pickup'),
  client_reference:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  items:z.array(z.strictObject({
    menu_item_id:positiveId,
    quantity:z.number().int().min(1).max(50),
    options:z.string().max(1000).default(''),
  })).min(1).max(100),
  tip:price.default('0'),
});
// Unsupported money-moving or incomplete commercial features deliberately
// return 503 rather than pretending to honor the full Python OrderCreate.
export function isCashPickupIntent(payload:unknown):boolean {
  if(!payload || typeof payload!=='object'||Array.isArray(payload))return false;
  const p=payload as Record<string,unknown>;
  return p.payment_method==='cash'&&p.order_type==='pickup'&&
    Object.keys(p).every(k=>k in intentSchema.shape);
}
const toMinor=(raw:string):bigint=>{
  if(!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(raw))
    throw new CheckoutError(422,'Importe inválido');
  const [a,b='']=raw.split('.');
  return BigInt(a!)*100n+BigInt((b+'00').slice(0,2));
};
const fromMinor=(c:bigint):string=>{
  if(c<0n||c>999_999_999_999n)throw new CheckoutError(422,'Importe fuera de límite');
  return (c/100n).toString()+'.'+(c%100n).toString().padStart(2,'0');
};
const toMilli=(s:string):bigint=>{
  if(!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,3})?$/.test(s))
    throw new CheckoutError(503,'Receta fuera de contrato de staging');
  const [a,b='']=s.split('.');
  return BigInt(a!)*1000n+BigInt((b+'000').slice(0,3));
};
const fromMilli=(n:bigint)=> (n/1000n).toString()+'.'+(n%1000n).toString().padStart(3,'0');
const roundRate=(c:bigint,basisPoints:bigint)=>(c*basisPoints+5000n)/10000n;
// Python commercial_value reads per-key SystemSetting overrides. This
// checkout supports only default v1.5.2 and v1.6.2 stage policy settings,
// never silently accepts customized rates or caps; exact 4-decimal comparison.
const rateBasisPoints=(raw:string):bigint=>{
  const v=raw.trim();
  if(!/^(?:0|[1-9]\d?)(?:\.\d{1,4})?$/.test(v))
    throw new CheckoutError(503,'Política comercial personalizada no compatible');
  const [major,fraction='']=v.split('.');
  return BigInt(major!)*10000n+BigInt((fraction+'0000').slice(0,4));
};
const canonicalize=(o:unknown):string=>{
  if(Array.isArray(o))return '['+o.map(canonicalize).join(',')+']';
  if(o!==null&&typeof o==='object')return '{'+Object.entries(o as Record<string,unknown>)
    .sort(([a],[b])=>a.localeCompare(b))
    .map(([k,v])=>JSON.stringify(k)+':'+canonicalize(v)).join(',')+'}';
  return JSON.stringify(o);
};
const signature=(v:unknown):string=>{
  if(!config.AUTH_JWT_SECRET)throw new CheckoutError(503,'Clave staging no configurada');
  return createHmac('sha256',config.AUTH_JWT_SECRET).update(canonicalize(v)).digest('hex');
};
const safeMatch=(a:unknown,b:string):boolean=>{
  if(typeof a!=='string'||!/^[0-9a-f]{64}$/.test(a))return false;
  return timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
};

export async function createCashPickupOnly(raw:unknown, account:AuthUser):Promise<number> {
  if(config.STAGE_PICKUP_CASH_CHECKOUT_ENABLED!=='true')
    throw new CheckoutError(503,'Checkout deshabilitado en staging');
  if(!['customer','admin'].includes(account.role))
    throw new CheckoutError(403,'No tienes permisos para crear pedidos');
  if(!isCashPickupIntent(raw))
    throw new CheckoutError(503,'Este checkout de staging sólo admite efectivo para recoger; demás métodos pendientes');
  const parsed=intentSchema.safeParse(raw);
  if(!parsed.success)throw new CheckoutError(422,'Datos del pedido inválidos');
  const data=parsed.data;
  const tip=toMinor(data.tip);
  if(tip>1_000_000n)throw new CheckoutError(422,'Propina fuera de límite');
  const itemIds=data.items.map(x=>x.menu_item_id);
  const totals=new Map<number,number>();
  for(const item of data.items)totals.set(item.menu_item_id,(totals.get(item.menu_item_id)??0)+item.quantity);
  if([...totals.values()].some(x=>x>50))throw new CheckoutError(422,'Cantidad de producto fuera de límite');
  const sortedIds=[...totals.keys()].sort((a,b)=>a-b);
  const fingerprint=signature(data);
  return db.$transaction(async tx=>{
    // Serialize retries with the same user, BEFORE testing client_reference.
    // Other customers then lock menu rows by ascending ID to avoid deadlocks.
    const locked=await tx.$queryRaw<{id:number}[]>`
      SELECT id FROM users WHERE id=${account.id} FOR UPDATE
    `;
    if(!locked.length)throw new CheckoutError(401,'Cuenta no disponible');
    const previous=await tx.marketOrder.findFirst({
      where:{userId:account.id,clientReference:data.client_reference},select:{id:true},
    });
    if(previous){
      const event=await tx.stageOrderEvent.findFirst({
        where:{orderId:previous.id,status:'received'},orderBy:{id:'asc'},
      });
      let saved:unknown;
      try{saved=JSON.parse(event?.metadataJson??'{}').checkout_intent_hmac;}catch{}
      if(!safeMatch(saved,fingerprint))
        throw new CheckoutError(409,'La referencia del pedido ya se uso con una compra diferente');
      return previous.id; // Idempotent retry: no second inventory or ledger mutation.
    }
    const restaurantLock=await tx.$queryRaw<{id:number}[]>`
      SELECT id FROM restaurants WHERE id=${data.restaurant_id} FOR SHARE
    `;
    if(!restaurantLock.length)throw new CheckoutError(404,'Restaurante no encontrado');
    const restaurant=await tx.marketplaceRestaurant.findUnique({where:{id:data.restaurant_id}});
    if(!restaurant)throw new CheckoutError(404,'Restaurante no encontrado');
    if(!restaurant.isOpen)throw new CheckoutError(400,'El restaurante está cerrado');
    if(!restaurant.pickupEnabled)throw new CheckoutError(400,'Este restaurante no permite recoger');
    const pricingV162=config.COMMERCIAL_PRICING_V162_ENABLED==='true';
    // Python uses v152 commission in both modes. In v162 the fee rate and
    // cap use separate settings; unrelated legacy settings must not override.
    const policyRows=await tx.$queryRaw<{key:string,value:string}[]>`
      SELECT key,value FROM system_settings
      WHERE key IN (
        'commercial_v152.restaurant_commission_rate',
        'commercial_v152.service_fee_rate',
        'commercial_v162.service_fee_rate',
        'commercial_v162.service_fee_cap'
      ) FOR SHARE
    `;
    for(const row of policyRows){
      let expected:bigint|null=null;
      if(row.key==='commercial_v152.restaurant_commission_rate')expected=1500n;
      if(!pricingV162 && row.key==='commercial_v152.service_fee_rate')expected=700n;
      if(pricingV162 && row.key==='commercial_v162.service_fee_rate')expected=700n;
      if(pricingV162 && row.key==='commercial_v162.service_fee_cap')expected=250000n;
      if(expected!==null && rateBasisPoints(row.value)!==expected)
        throw new CheckoutError(503,'Tarifas configuradas distintas al checkout de staging');
    }
    // Fail closed if the runtime has nondefault commercial policies. These
    // rates are Python commercial v1.5.2 DEFAULTS, not full SystemSetting parity.
    if(restaurant.commercialPlan!=='START'&&restaurant.commercialPlan!=='DELIVERY'&&
       restaurant.commercialPlan!=='PRO')
      throw new CheckoutError(503,'Política comercial personalizada aún no compatible');
    for(const id of sortedIds){
      await tx.$queryRaw`SELECT id FROM menu_items WHERE id=${id} FOR UPDATE`;
    }
    const rows=await tx.marketplaceMenuItem.findMany({
      where:{id:{in:sortedIds},restaurantId:restaurant.id},
    });
    if(rows.length!==sortedIds.length)
      throw new CheckoutError(400,'Uno o más productos no pertenecen al restaurante');
    const menu=new Map(rows.map(x=>[x.id,x]));
    let subtotal=0n;
    const amounts=new Map<number,bigint>();
    for(const id of sortedIds){
      const item=menu.get(id)!;
      if(!item.isAvailable||item.stock<totals.get(id)!)
        throw new CheckoutError(400,item.name+' no tiene stock suficiente');
      if(item.priceScheduleJson.trim()!=='{}'||
         item.availabilityScheduleJson.trim()!=='{}'||
         item.optionsJson.trim()!=='[]')
        throw new CheckoutError(503,'Horarios, precios dinámicos u opciones del producto pendientes');
      const amount=toMinor(item.price.toString());
      if(amount<=0n)throw new CheckoutError(503,'Precio no válido en staging');
      amounts.set(id,amount);
    }
    for(const line of data.items){
      if(line.options!=='')
        throw new CheckoutError(503,'Opciones del producto pendientes de validar');
      subtotal+=amounts.get(line.menu_item_id)!*BigInt(line.quantity);
    }
    const recipes=await tx.stageMenuRecipe.findMany({where:{menuItemId:{in:sortedIds}}});
    const ingredientUsage=new Map<number,bigint>();
    for(const recipe of recipes){
      const value=toMilli(recipe.quantityRequired.toString())*BigInt(totals.get(recipe.menuItemId)!);
      ingredientUsage.set(recipe.ingredientId,(ingredientUsage.get(recipe.ingredientId)??0n)+value);
    }
    for(const id of [...ingredientUsage.keys()].sort((a,b)=>a-b)){
      await tx.$queryRaw`SELECT id FROM ingredient_stocks WHERE id=${id} FOR UPDATE`;
      const ingredient=await tx.stageIngredientStock.findUnique({where:{id}});
      if(!ingredient||ingredient.restaurantId!==restaurant.id||
          toMilli(ingredient.quantity.toString())<ingredientUsage.get(id)!)
        throw new CheckoutError(400,'Inventario de ingredientes insuficiente');
    }
    // Python default pickup cash: 15% restaurant commission, 7% of net food
    // to customer, 100% tip to merchant. In v1.6.2, fee is capped at MXN 25.
    // Only fixed default policies are supported here; custom overrides 503.
    const commission=roundRate(subtotal,1500n);
    const uncappedFee=roundRate(subtotal,700n);
    const serviceFee=pricingV162 && uncappedFee>2500n?2500n:uncappedFee;
    const restaurantPayout=subtotal-commission+tip;
    const platformRevenue=commission+serviceFee;
    const total=subtotal+serviceFee+tip;
    // Defensively reject overflow before any monetary DB writes.
    [subtotal,commission,serviceFee,restaurantPayout,platformRevenue,total].forEach(fromMinor);
    const order=await tx.marketOrder.create({
      data:{
        userId:account.id,restaurantId:restaurant.id,
        address:data.address,notes:data.notes,clientReference:data.client_reference,
        deliveryPin:String(randomInt(0,10_000)).padStart(4,'0'),
        orderType:'pickup',paymentMethod:'cash',paymentStatus:'pending',
        paymentProvider:'cash',status:'received',
        subtotal:fromMinor(subtotal),deliveryFee:'0.00',
        tip:fromMinor(tip),total:fromMinor(total),
        platformCommission:fromMinor(commission),serviceFee:fromMinor(serviceFee),
        restaurantPayout:fromMinor(restaurantPayout),
        platformRevenue:fromMinor(platformRevenue),contributionMargin:fromMinor(platformRevenue),
        driverEarning:'0.00',estimatedMinutes:restaurant.etaMin,
        distanceKm:0,
        inventoryReservedJson:JSON.stringify(Object.fromEntries(
          [...ingredientUsage.entries()].map(([id,needed])=>[String(id),fromMilli(needed)]))),
      },
    });
    for(const id of sortedIds){
      const quantity=totals.get(id)!;
      const changed=await tx.$queryRaw<{id:number}[]>`
        UPDATE menu_items SET stock=stock-${quantity}
        WHERE id=${id} AND restaurant_id=${restaurant.id}
        AND is_available=true AND stock>=${quantity} RETURNING id
      `;
      if(changed.length!==1)throw new CheckoutError(400,'Stock insuficiente');
    }
    for(const id of [...ingredientUsage.keys()].sort((a,b)=>a-b)){
      const needed=fromMilli(ingredientUsage.get(id)!);
      const changed=await tx.$queryRaw<{id:number}[]>`
        UPDATE ingredient_stocks SET quantity=quantity-${needed}::numeric
        WHERE id=${id} AND restaurant_id=${restaurant.id}
        AND quantity>=${needed}::numeric RETURNING id
      `;
      if(changed.length!==1)throw new CheckoutError(400,'Inventario de ingredientes insuficiente');
    }
    await tx.marketOrderItem.createMany({data:data.items.map(item=>({
      orderId:order.id,menuItemId:item.menu_item_id,
      nameSnapshot:menu.get(item.menu_item_id)!.name,
      quantity:item.quantity,unitPrice:fromMinor(amounts.get(item.menu_item_id)!),
      optionsSnapshot:item.options,
    }))});
    await tx.stageOrderEvent.create({data:{
      orderId:order.id,status:'received',actorUserId:account.id,
      metadataJson:JSON.stringify({source:'checkout',checkout_intent_hmac:fingerprint}),
    }});
    const payload={order_id:order.id,status:'received',payment_status:'pending',
      user_id:account.id,restaurant_id:restaurant.id};
    await tx.stageEventOutbox.create({data:{
      eventKey:'order:'+order.id+':created',aggregateType:'order',
      aggregateId:String(order.id),eventType:'order.created',
      payloadJson:JSON.stringify(payload),
    }});
    const entries=[
      ['gmv',total,'GMV del pedido'],
      ['restaurant_payable',restaurantPayout,'Saldo por pagar al restaurante'],
      ['platform_revenue',platformRevenue,'Ingreso bruto Tala Eats'],
      ['contribution_margin',platformRevenue,'Margen de contribución estimado'],
    ] as const;
    for(const [accountName,value,description] of entries){
      if(value<=0n)continue;
      await tx.stageFinancialLedgerEntry.create({data:{
        orderId:order.id,userId:account.id,restaurantId:restaurant.id,
        account:accountName,direction:'credit',amount:fromMinor(value),
        kind:'order_settlement',description,
        idempotencyKey:'order:'+order.id+':ledger:'+accountName,
      }});
    }
    await tx.authNotification.create({data:{
      userId:account.id,kind:'order',title:'Pedido recibido',
      message:'Tu pedido #'+order.id+' llegó a '+restaurant.name+'.',
    }});
    if(restaurant.ownerId){
      await tx.authNotification.create({data:{
        userId:restaurant.ownerId,kind:'restaurant_order',title:'Nuevo pedido',
        message:'Pedido #'+order.id+' recibido en '+restaurant.name+'.',
      }});
    }
    return order.id;
  },{maxWait:10_000,timeout:20_000});
}
