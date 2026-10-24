/** RC8.5 agreed commercial policy for FUTURE real delivery orders.
 * Independent of historical Python parity/staging pricing. Integer centavos.
 * No live delivery route is enabled by this function alone.
 */
export const RC85_TERMS=Object.freeze({
 merchantCommissionBps:1500,clientServiceBps:700,
 baseDeliveryMinor:3900,driverBaseMinor:3200
});
const round=(n:bigint,d:bigint)=>{if(d<=0n||n<0n)throw Error('INVALID_RATIO');return (n+d/2n)/d;};
const chk=(n:bigint)=>{if(n<0n||n>9999999999n)throw Error('AMOUNT_OUT_OF_RANGE');};
export function quoteTalaRC85(input:{
 productsMinor:bigint;discountMinor:bigint;tipMinor:bigint;
 fulfillment:'pickup'|'platform_delivery'|'merchant_delivery';
}){
 const {productsMinor,discountMinor,tipMinor,fulfillment}=input;
 chk(productsMinor);chk(discountMinor);chk(tipMinor);
 if(discountMinor>productsMinor)throw Error('DISCOUNT_EXCEEDS_PRODUCTS');
 const net=productsMinor-discountMinor;
 const restaurantCommission=round(net*1500n,10000n);
 const serviceFee=round(net*700n,10000n);
 const shippingFee=fulfillment==='pickup'?0n:3900n;
 const driverBase=fulfillment==='platform_delivery'?3200n:0n;
 const restaurantPayable=net-restaurantCommission+
   (fulfillment==='merchant_delivery'?shippingFee+tipMinor:
    fulfillment==='pickup'?tipMinor:0n);
 const driverPayable=driverBase+
   (fulfillment==='platform_delivery'?tipMinor:0n);
 const total=net+serviceFee+shippingFee+tipMinor;
 const platformGross=total-restaurantPayable-driverPayable;
 for(const amount of [restaurantCommission,serviceFee,shippingFee,
     restaurantPayable,driverPayable,total,platformGross])chk(amount);
 return {totalMinor:total,productsMinor:net,commissionMinor:restaurantCommission,
   serviceFeeMinor:serviceFee,shippingMinor:shippingFee,
   restaurantPayableMinor:restaurantPayable,
   driverBaseMinor:driverBase,driverPayableMinor:driverPayable,
   platformGrossBeforeStripeAndTaxMinor:platformGross,
   tipMinor,fulfillment,commissionOnTipMinor:0n};
}
