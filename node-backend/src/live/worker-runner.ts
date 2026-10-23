/**
 * Independent RC8 finance worker iteration.
 *
 * Operates only on preverified/durable provider receipts in independent PG.
 * It never creates Stripe charges, refunds, transfers, payouts, or new orders.
 * Failed/canceled and refund/dispute events deliberately remain on HOLD for
 * explicit compensation before a production release can be approved.
 */
import type {Pool} from 'pg';
import type {LiveStripeApi} from './stripe-payments.js';
import type {ValidatedLiveSettings} from './guard.js';
import {drainLiveSignedReceipts,drainLiveRefundReceipts,drainLiveCanceledReceipts,drainLiveRefundFailures,drainLiveDisputeReceipts} from './webhook-inbox.js';
import {inspectLiveFinancialData} from './financial-readiness.js';

export type Rc8WorkerReport={
  checked:number;
  reconciled:number;
  held:number;
  pendingPaymentEvents:number;
  pendingRefundOrDisputeEvents:number;
  orphanedProviderReservations:number;
  suspectPaidOrders:number;
  releaseHold:true;
};

export async function rc8WorkerIteration(
  provider:LiveStripeApi,pool:Pool,settings:ValidatedLiveSettings,
  batchSize=20):Promise<Rc8WorkerReport>{
  // Do not guess from Stripe event delivery timing: successful captures are
  // reconciled under PG row locks. No other event classes are compensated.
  const result=await drainLiveSignedReceipts(provider,pool,settings,batchSize);
  const refunds=await drainLiveRefundReceipts(provider,pool,Math.min(batchSize,20));
  const cancellations=await drainLiveCanceledReceipts(provider,pool,Math.min(batchSize,20));
  const refundFailures=await drainLiveRefundFailures(provider,pool,Math.min(batchSize,20));
  const disputes=await drainLiveDisputeReceipts(provider,pool,Math.min(batchSize,20));
  const audit=await inspectLiveFinancialData(pool);
  const c=audit.counters;
  return {
    checked:result.checked+refunds.checked+cancellations.checked+refundFailures.checked+disputes.checked,
    reconciled:result.reconciled+refunds.reconciled+cancellations.reconciled+refundFailures.reconciled+disputes.reconciled,
    held:result.held+refunds.held+cancellations.held+refundFailures.held+disputes.held,
    pendingPaymentEvents:c.pendingPaymentReceipts,
    pendingRefundOrDisputeEvents:c.pendingRefundOrDisputeEvents,
    orphanedProviderReservations:c.stuckProviderReservations,
    suspectPaidOrders:c.suspectCapturedOrders,
    // A green batch is not approval for commercial payments/payouts.
    releaseHold:true
  };
}
