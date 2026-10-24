/**
 * The public Flutter payment contract. Stripe TEST is never advertised in
 * production and Stripe LIVE is never advertised in staging.
 *
 * This is capability discovery, NOT authorization for a specific charge:
 * order creation still requires buyer auth, a verified seller Connect
 * mapping, financial reconciliation, and a valid pickup basket.
 */
export type PublicPaymentOptions = {
  environment:'staging'|'production';
  cashEnabled:boolean;
  stripeTestEnabled:boolean;
  stripeLiveEnabled:boolean;
  financialWritesEnabled:boolean;
  releaseApproved:boolean;
  refundsEnabled:boolean;
  manualSettlementApproved:boolean;
  publishableKey:string|undefined;
};

export function buildPublicPaymentContracts(o:PublicPaymentOptions){
  const live=o.environment==='production';
  const enabled=live
    ? o.stripeLiveEnabled&&o.financialWritesEnabled&&o.releaseApproved&&
      o.refundsEnabled&&o.manualSettlementApproved&&
      Boolean(o.publishableKey?.startsWith('pk_live_'))
    : o.stripeTestEnabled&&Boolean(o.publishableKey?.startsWith('pk_test_'));
  const mode=live?'live-pickup-only':'test-pickup-only';
  const key=enabled?o.publishableKey??null:null;
  return {
    methods:{
      digital_provider:'stripe',
      cash_available_in_staging:!live&&o.cashEnabled,
      cash_available:o.cashEnabled,
      methods:[
        {
          id:'cash',label:'Efectivo',enabled:o.cashEnabled,
          mode:live?'live-cash-pickup':'stage-cash-pickup',
          ...(o.cashEnabled?{}:{reason:'cash-pickup-disabled'}),
        },
        {
          id:'stripe',label:live?'Tarjeta (Stripe)':'Tarjeta (Stripe TEST)',
          enabled,mode:live?'live-stripe-pickup':'stage-stripe-test-pickup',
          ...(enabled?{}:{reason:live?'stripe-live-payments-disabled':'stripe-test-payments-disabled'}),
        },
        {id:'wallet',label:'Wallet',enabled:false,reason:'wallet-not-reconciled'},
      ],
      production_ready:live&&enabled,
      seller_connect_required:live,
    },
    paymentsConfig:{
      provider:'stripe',digital_providers:['stripe'],enabled,
      publishable_key:key,checkout_ready:enabled,
      financial_writes_enabled:live&&enabled,
      environment:o.environment,mode,
    },
    stripeConfig:{
      provider:'stripe',enabled,publishable_key:key,
      checkout_ready:enabled,financial_writes_enabled:live&&enabled,
      environment:o.environment,mode,
      merchant_country:'MX',
    },
  };
}
