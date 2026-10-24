/**
 * Read-only RC8 go-live financial data gate, separately connected to
 * PRODUCTION PostgreSQL. No PII, SQL writes, Stripe calls or deployment side
 * effects. This is a necessary, never sufficient, production release gate.
 */
import type {Pool} from 'pg';

export type LiveFinancialCounters={
  pendingPaymentReceipts:number;
  pendingRefundOrDisputeEvents:number;
  suspectCapturedOrders:number;
  stuckProviderReservations:number;
};
export function assessLiveFinancialCounters(c:LiveFinancialCounters):
  'LIVE_FINANCIAL_DATA_PASS'|'LIVE_FINANCIAL_DATA_HOLD'{
  return Object.values(c).length===4&&
    Object.values(c).every(n=>Number.isSafeInteger(n)&&n===0)
      ? 'LIVE_FINANCIAL_DATA_PASS':'LIVE_FINANCIAL_DATA_HOLD';
}
export async function inspectLiveFinancialData(pool:Pool):
 Promise<{classification:'LIVE_FINANCIAL_DATA_PASS'|'LIVE_FINANCIAL_DATA_HOLD';
          liveEnabled:false;counters:LiveFinancialCounters}>{
  const result=await pool.query<{
    pending_payment_receipts:string;
    pending_refund_or_dispute_events:string;
    suspect_captured_orders:string;
    stuck_provider_reservations:string;
  }>(`
    SELECT
      (SELECT count(*) FROM stripe_webhook_events
       WHERE status IN ('RECEIVED','FAILED')
         AND type IN ('payment_intent.succeeded',
           'payment_intent.payment_failed','payment_intent.canceled'))
       AS pending_payment_receipts,
      -- Financial review is NOT completed merely because a webhook was
      -- marked PROCESSED or an outbox notification was PUBLISHED. Refunds
      -- and chargebacks require merchant-payable and fulfillment signoff.
      (
        (SELECT count(*) FROM stripe_webhook_events e
         WHERE
           (e.status IN ('RECEIVED','FAILED') AND e.type IN
              ('charge.refunded','charge.dispute.created',
               'charge.dispute.closed','refund.created','refund.updated',
               'refund.failed','charge.refund.updated'))
           OR (
             e.type IN ('charge.dispute.created','charge.dispute.closed',
               'charge.refunded','charge.refund.updated')
             AND NOT EXISTS (
               SELECT 1 FROM tala_live_financial_cases c
               WHERE c.stripe_object_id=e."objectId"
                 AND c.case_type=CASE
                   WHEN e.type LIKE 'charge.dispute.%' THEN 'dispute'
                   ELSE 'charge_refund' END
                 AND c.status='resolved')))
        +
        (SELECT count(*) FROM tala_live_financial_cases
          WHERE status IN ('open','reviewed'))
        +
        (SELECT count(*) FROM event_outbox o
         WHERE o.event_type IN ('order.refund_review_required',
           'order.refund_failure_review_required',
           'order.dispute_review_required')
           AND NOT EXISTS (
             SELECT 1 FROM tala_live_financial_cases c
             WHERE c.order_id::text=o.aggregate_id
               AND c.status='resolved'
               AND ((o.event_type='order.refund_review_required' AND c.case_type='refund')
                 OR (o.event_type='order.refund_failure_review_required' AND c.case_type='refund_failure')
                 OR (o.event_type='order.dispute_review_required' AND c.case_type='dispute'))))
      ) AS pending_refund_or_dispute_events,
      -- A refunded order must never disappear from the financial audit:
      -- it still requires its original immutable captured-money receipt,
      -- and all reversals must match the actual cumulative refunded amount.
      (SELECT count(*) FROM orders o
       WHERE o.payment_method='stripe'
         AND o.payment_status IN ('paid','partially_refunded','refunded')
         AND (
           NOT EXISTS (SELECT 1 FROM financial_ledger_entries l
             WHERE l.order_id=o.id
               AND l.account='stripe_live_collected'
               AND l.kind='stripe_live_payment'
               AND l.direction='credit'
               AND l.idempotency_key=('order:'||o.id||':stripe-live:collected')
               AND l.amount=o.total)
           OR o.refunded_amount < 0
           OR o.refunded_amount > o.total
           OR (o.payment_status='paid' AND o.refunded_amount > 0)
           OR (o.payment_status='refunded' AND o.refunded_amount <> o.total)
           OR (o.payment_status='partially_refunded' AND
                (o.refunded_amount <= 0 OR o.refunded_amount >= o.total))
           OR (
             COALESCE((SELECT SUM(l.amount) FROM financial_ledger_entries l
               WHERE l.order_id=o.id
                 AND l.account='stripe_live_collected'
                 AND l.direction='debit'
                 AND l.kind='stripe_live_refund'),0)
             -
             COALESCE((SELECT SUM(l.amount) FROM financial_ledger_entries l
               WHERE l.order_id=o.id
                 AND l.account='stripe_live_collected'
                 AND l.direction='credit'
                 AND l.kind='stripe_live_refund_failure'),0)
             <> o.refunded_amount)
         ))
       AS suspect_captured_orders,
      (SELECT count(*) FROM orders
       WHERE payment_method='stripe' AND payment_status='pending'
         AND payment_provider_id='pi_reserving_rc8_live'
         AND created_at < NOW() - INTERVAL '10 minutes')
       AS stuck_provider_reservations
  `);
  const row=result.rows[0];
  if(!row||result.rows.length!==1)throw Error('LIVE_FINANCIAL_AUDIT_INVALID');
  const parse=(v:string):number=>{
    if(!/^(0|[1-9]\d*)$/.test(v))throw Error('LIVE_AUDIT_COUNT_INVALID');
    const n=Number(v);
    if(!Number.isSafeInteger(n))throw Error('LIVE_AUDIT_COUNT_OVERFLOW');
    return n;
  };
  const counters={
    pendingPaymentReceipts:parse(row.pending_payment_receipts),
    pendingRefundOrDisputeEvents:parse(row.pending_refund_or_dispute_events),
    suspectCapturedOrders:parse(row.suspect_captured_orders),
    stuckProviderReservations:parse(row.stuck_provider_reservations),
  };
  return {classification:assessLiveFinancialCounters(counters),
    liveEnabled:false,counters};
}
