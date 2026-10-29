/**
 * RC8.7: exact money posting for a captured Stripe LIVE pickup order.
 *
 * Stripe capture receipts are written separately, once, under the order row
 * lock. These are accounting projections, NOT funds available for payout.
 * A negative contribution margin is an expense (debit), never a malformed
 * payment. Decimals and directions are normalized without floating point.
 */
export type LiveSettlementFigures = {
  total:string;
  restaurantPayout:string;
  platformRevenue:string;
  paymentProcessingFee:string;
  contributionMargin:string;
  driverEarning?:string; // Mandatory for card delivery; pickup defaults to zero.
  fulfillment?:'pickup'|'delivery';
};
export type LiveSettlementPosting = {
  account:'gmv'|'restaurant_payable'|'driver_payable'|'platform_revenue'|
    'payment_processing'|'contribution_margin';
  amount:string;
  direction:'credit'|'debit';
};
const decimal=/^-?(?:0|[1-9]\d{0,7})\.\d{2}$/;
const posDecimal=/^(?:0|[1-9]\d{0,7})\.\d{2}$/;
function toMinor(v:string,signed:boolean):bigint {
  if(typeof v!=='string'||!(signed?decimal:posDecimal).test(v))
    throw new RangeError('INVALID_LIVE_SETTLEMENT_AMOUNT');
  const negative=v.startsWith('-');
  const parts=(negative?v.slice(1):v).split('.');
  const n=BigInt(parts[0]!)*100n+BigInt(parts[1]!);
  return negative?-n:n;
}
function absMoney(n:bigint):string{
  const value=n<0n?-n:n;
  return (value/100n).toString()+'.'+(value%100n).toString().padStart(2,'0');
}
export function liveSettlementPostings(f:LiveSettlementFigures):LiveSettlementPosting[]{
  const total=toMinor(f.total,false);
  const restaurant=toMinor(f.restaurantPayout,false);
  const platform=toMinor(f.platformRevenue,false);
  const processing=toMinor(f.paymentProcessingFee,false);
  const margin=toMinor(f.contributionMargin,true);
  const driver=toMinor(f.driverEarning??'0.00',false);
  if(f.fulfillment==='delivery'&&(driver<=0n||restaurant+driver+platform!==total))
    throw new RangeError('LIVE_DELIVERY_PAYEE_CONSERVATION_MISMATCH');
  if(total<=0n||restaurant>total||driver>total||
      margin!==platform-processing)
    throw new RangeError('LIVE_SETTLEMENT_BREAKDOWN_MISMATCH');
  const items=[
    {account:'gmv',value:total,direction:'credit'},
    {account:'restaurant_payable',value:restaurant,direction:'credit'},
    {account:'driver_payable',value:driver,direction:'credit'},
    {account:'platform_revenue',value:platform,direction:'credit'},
    {account:'payment_processing',value:processing,direction:'debit'},
    {account:'contribution_margin',value:margin,direction:margin<0n?'debit':'credit'},
  ] as const;
  return items.filter(x=>x.value!==0n).map(x=>({
    account:x.account,amount:absMoney(x.value),direction:x.direction,
  }));
}
