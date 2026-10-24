/**
 * Deterministic, test-only pricing mirror of backend/app/monetization.py
 * Python commercial_v152 / commercial_v162 DEFAULTS.
 * All monetary values are integer centavos. No external PSP calls.
 * Custom fee overrides, coupons, PLUS, taxes and merchant-managed delivery
 * must be validated separately: this function does not authorize checkout.
 */
export type FinancialPolicy = 'v152'|'v162';
export type Tender = 'cash'|'stripe';
export type Fulfillment = 'pickup'|'delivery';
export type PriceInput = {
  policy:FinancialPolicy;
  method:Tender;
  fulfillment:Fulfillment;
  subtotal:bigint;
  discount:bigint;
  tip:bigint;
  // Millikilometers: 2500 = 2.500 km; ALWAYS server-calculated, never trust mobile.
  distanceMilliKm?:bigint;
  // v1.5.2 only: dynamic restaurant delivery quote in centavos.
  restaurantDeliveryQuote?:bigint;
  merchantManagedDelivery?:boolean;
};
export type PriceBreakdown = {
  merchandise:bigint;
  commission:bigint;
  serviceFee:bigint;
  deliveryFee:bigint;
  tip:bigint;
  driverEarning:bigint;
  driverPayable:bigint;
  restaurantPayable:bigint;
  platformRevenue:bigint;
  gatewayProcessingEstimate:bigint;
  contributionMargin:bigint;
  total:bigint;
};
export function halfUp(n:bigint,d:bigint):bigint {
  if(d<=0n||n<0n)throw new RangeError('Only nonnegative monetary ratios are supported');
  return (n+d/2n)/d;
}
export const fmtCents=(value:bigint):string=>{
  const abs=value<0n?-value:value;
  return (value<0n?'-':'')+(abs/100n).toString()+'.'+(abs%100n).toString().padStart(2,'0');
};
const max=(a:bigint,b:bigint)=>a>b?a:b;
export function calculateDefaultCommercial(input:PriceInput):PriceBreakdown {
  const {policy,method,fulfillment}=input;
  if(!['v152','v162'].includes(policy)||!['cash','stripe'].includes(method)||
     !['pickup','delivery'].includes(fulfillment))
    throw new RangeError('Unsupported policy, tender or order type');
  const monetary=[input.subtotal,input.discount,input.tip];
  if(monetary.some(n=>n<0n||n>9999999999n)||
     input.discount>input.subtotal)throw new RangeError('Invalid monetary amount');
  const distance=input.distanceMilliKm??0n;
  if(distance<0n||distance>100000n)throw new RangeError('Invalid geographic distance');
  const merchantDelivery=input.merchantManagedDelivery===true;
  if(merchantDelivery&&fulfillment!=='delivery')
    throw new RangeError('Merchant-managed delivery only for delivery orders');
  const food=input.subtotal-input.discount;
  const commission=halfUp(food*1500n,10000n);
  const rawService=halfUp(food*700n,10000n);
  const serviceFee=policy==='v162'&&rawService>2500n?2500n:rawService;
  let deliveryFee=0n;
  if(fulfillment==='delivery'){
    if(policy==='v162'){
      // Python v1.6.2: MXN 35 includes 2 km; +MXN 5/km after that.
      deliveryFee=3500n+halfUp(max(0n,distance-2000n)*500n,1000n);
    } else {
      const quote=input.restaurantDeliveryQuote??3900n;
      if(quote<0n||quote>1_000_000n)throw new RangeError('Invalid v152 delivery quote');
      deliveryFee=max(3900n,quote);
    }
  }
  let driverEarning=0n;
  if(fulfillment==='delivery'&&!merchantDelivery){
    driverEarning=max(halfUp(deliveryFee*7000n,10000n),3200n);
    if(policy==='v162')
      driverEarning=max(driverEarning,3200n+halfUp(max(0n,distance-2000n)*400n,1000n));
  }
  const restaurantPayable=food-commission+
    (merchantDelivery?deliveryFee+input.tip:fulfillment==='pickup'?input.tip:0n);
  const driverPayable=driverEarning+
    (fulfillment==='delivery'&&!merchantDelivery?input.tip:0n);
  const platformRevenue=commission+serviceFee+
    (merchantDelivery?0n:deliveryFee-driverEarning);
  const total=food+deliveryFee+input.tip+serviceFee;
  // Python legacy estimates Stripe processing 3.60% + MXN 3 + 16% tax.
  // This is not the actual Stripe fee and is NEVER a payout authorization.
  const gatewayProcessingEstimate=method==='stripe'
    ?halfUp((total*360n+300n*10000n)*11600n,10000n*10000n):0n;
  const contributionMargin=platformRevenue-gatewayProcessingEstimate;
  return {merchandise:food,commission,serviceFee,deliveryFee,tip:input.tip,
    driverEarning,driverPayable,restaurantPayable,platformRevenue,
    gatewayProcessingEstimate,contributionMargin,total};
}
