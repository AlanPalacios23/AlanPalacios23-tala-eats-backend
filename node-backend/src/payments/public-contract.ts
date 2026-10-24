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
  pricingV162Enabled?:boolean;
};

export function buildPublicPaymentContracts(o:PublicPaymentOptions){
  const live=o.environment==='production';
  const enabled=live
    ? o.stripeLiveEnabled&&o.financialWritesEnabled&&o.releaseApproved&&
      o.refundsEnabled&&o.manualSettlementApproved&&
      Boolean(o.publishableKey?.startsWith('pk_live_'))
    : o.stripeTestEnabled&&Boolean(o.publishableKey?.startsWith('pk_test_'));
  // No checkout whatsoever in production standby with only test merchants.
  const cashEnabled=o.cashEnabled&&(!live||enabled);
  const mode=live?'live-pickup-only':'test-pickup-only';
  const key=enabled?o.publishableKey??null:null;
  return {
    methods:{
      // Informacion comercial informativa. SOLO pickup es cobrable en Node RC8:
      // no se expone una cotizacion de delivery sin coordenadas y un motor
      // servidor de distancias. La creación del pedido recalcula y valida.
      commercial_pricing_version:o.pricingV162Enabled?'1.6.2':'1.5.2',
      service_fee_rate:'0.07',
      ...(o.pricingV162Enabled?{
        service_fee_cap:'25.00',
        delivery_base_fee:'35.00',
        delivery_included_km:'2',
        delivery_additional_per_km:'5.00',
      }:{
        delivery_base_fee:'39.00',
      }),
      delivery_checkout_supported:false,
      pickup_checkout_supported:true,
      digital_provider:'stripe',
      cash_available_in_staging:!live&&cashEnabled,
      cash_available:cashEnabled,
      methods:[
        {
          id:'cash',label:'Efectivo',enabled:cashEnabled,
          mode:live?'live-cash-pickup':'stage-cash-pickup',
          ...(cashEnabled?{}:{reason:'cash-pickup-disabled'}),
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
