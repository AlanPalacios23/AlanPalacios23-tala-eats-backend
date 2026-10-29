/**
 * RC11.4: pure, fail-closed, read-only audit for a delivered production
 * CASH-at-door order. It NEVER declares funds withdrawable.
 * Money is parsed as integer centavos (no floating-point comparisons).
 * This is a reconciliation control, not a payment or disbursement adapter.
 */
const minor = raw => {
  const str = typeof raw === 'string' ? raw : String(raw);
  if (!/^(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/.test(str))
    throw Error('INVALID_MXN_AMOUNT');
  const [a, b=''] = str.split('.');
  return BigInt(a) * 100n + BigInt((b + '00').slice(0, 2));
};
const same = (a,b) => a === b;
const report = findings => ({
  pass: findings.length === 0,
  findings: [...new Set(findings)].sort(),
  withdrawable: false,
});
export function auditDeliveredLiveCashOrder(order, entries, proof) {
  const errors = [];
  if (!order || !Number.isSafeInteger(order.id) || order.id < 1 ||
      !Array.isArray(entries)) return report(['INVALID_AUDIT_INPUT']);
  if (order.orderType !== 'delivery' || order.paymentMethod !== 'cash')
    return report(['NOT_LIVE_CASH_DELIVERY']);
  if (order.status !== 'delivered' || order.paymentStatus !== 'paid')
    errors.push('DELIVERY_NOT_PAID_AND_COMPLETED');
  if (!Number.isSafeInteger(order.driverId) || order.driverId < 1)
    errors.push('NO_ASSIGNED_DRIVER');
  if (!proof || proof.pinVerified !== true ||
      proof.orderId !== order.id || proof.driverId !== order.driverId)
    errors.push('MISSING_MATCHING_PIN_PROOF');
  let amounts;
  try {
    amounts = Object.fromEntries([
      'total','subtotal','discount','deliveryFee','tip','serviceFee',
      'platformCommission','restaurantPayout','driverEarning',
      'platformRevenue','paymentProcessingFee','contributionMargin',
      'cashCollected','refundedAmount',
    ].map(k => [k, minor(order[k])]));
  } catch {return report([...errors,'INVALID_ORDER_MONEY']);}
  const a = amounts;
  if (!same(a.refundedAmount,0n)) errors.push('REFUND_REQUIRES_SEPARATE_RECONCILIATION');
  if (a.total === 0n || a.discount > a.subtotal)
    errors.push('INVALID_ORDER_AMOUNT');
  const food = a.subtotal-a.discount;
  if (!same(a.total,food+a.deliveryFee+a.tip+a.serviceFee))
    errors.push('CUSTOMER_TOTAL_MISMATCH');
  if (!same(a.restaurantPayout,food-a.platformCommission))
    errors.push('RESTAURANT_PAYABLE_MISMATCH');
  if (a.paymentProcessingFee!==0n||a.contributionMargin!==a.platformRevenue)
    errors.push('CASH_PROCESSING_OR_MARGIN_MISMATCH');
  const driverPayable = a.driverEarning+a.tip;
  if (!same(a.platformRevenue,a.platformCommission+a.serviceFee+
    a.deliveryFee-a.driverEarning))
    errors.push('PLATFORM_REVENUE_MISMATCH');
  if (!same(a.total,a.restaurantPayout+driverPayable+a.platformRevenue))
    errors.push('ORDER_SPLIT_NOT_CONSERVED');
  if (!same(a.cashCollected,a.total))
    errors.push('CASH_COLLECTED_MISMATCH');
  const expected = new Map([
    ['gmv',a.total],['restaurant_payable',a.restaurantPayout],
    ['driver_payable',driverPayable],['platform_revenue',a.platformRevenue],
    ['payment_processing',a.paymentProcessingFee],
    ['contribution_margin',a.contributionMargin],
  ]);
  const check = (kind,account,amount,key) => {
    const rows=entries.filter(e=>e.kind===kind&&e.account===account);
    if (rows.length!==1) {
      errors.push('LEDGER_ENTRY_COUNT_'+account.toUpperCase());
      return;
    }
    const row=rows[0];
    if (row.direction!=='credit' || row.currency!=='MXN' ||
        row.idempotencyKey!==key) errors.push('LEDGER_ENTRY_IDENTITY_'+account.toUpperCase());
    try {
      if (minor(row.amount)!==amount)
        errors.push('LEDGER_AMOUNT_'+account.toUpperCase());
    } catch {errors.push('LEDGER_INVALID_MONEY_'+account.toUpperCase());}
  };
  for(const [account,value] of expected){
    // Checkout intentionally omits zero-valued accrual entries.
    if(value===0n) {
      if(entries.some(e=>e.kind==='order_settlement'&&e.account===account))
        errors.push('UNEXPECTED_ZERO_LEDGER_'+account.toUpperCase());
      continue;
    }
    check('order_settlement',account,value,
      'order:'+order.id+':ledger:'+account);
  }
  check('cash_delivery_collection','cash_collected_by_driver',a.total,
    'order:'+order.id+':cash-delivery:collected');
  const allowedSettlement=new Set(expected.keys());
  if(entries.some(e=>e.kind==='order_settlement'&&!allowedSettlement.has(e.account)))
    errors.push('UNRECOGNIZED_SETTLEMENT_ACCOUNT');
  if(entries.some(e=>e.kind!=='order_settlement'&&e.kind!=='cash_delivery_collection'))
    errors.push('UNRECONCILED_NONSTANDARD_LEDGER');
  if(entries.some(e=>e.kind==='order_cancellation' ||
      ['stripe_live_refund','stripe_live_dispute','stripe_live_reversal'].includes(e.kind)))
    errors.push('FINANCIAL_RISK_REQUIRES_REVIEW');
  if(entries.some(e=>e.currency!=='MXN' || !['debit','credit'].includes(e.direction)))
    errors.push('INVALID_LEDGER_CURRENCY_OR_DIRECTION');
  if(new Set(entries.map(e=>e.idempotencyKey)).size!==entries.length)
    errors.push('DUPLICATE_LEDGER_IDEMPOTENCY_KEY');
  return report(errors);
}
