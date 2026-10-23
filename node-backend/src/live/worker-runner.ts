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
import {drainLiveSignedReceipts} from './webhook-inbox.js';
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
  const audit=await inspectLiveFinancialData(pool);
  const c=audit.counters;
  return {
    checked:result.checked,reconciled:result.reconciled,held:result.held,
    pendingPaymentEvents:c.pendingPaymentReceipts,
    pendingRefundOrDisputeEvents:c.pendingRefundOrDisputeEvents,
    orphanedProviderReservations:c.stuckProviderReservations,
    suspectPaidOrders:c.suspectCapturedOrders,
    // A green batch is not approval for commercial payments/payouts.
    releaseHold:true
  };
}
