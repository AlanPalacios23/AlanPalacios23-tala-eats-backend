-- RC11.6 LIVE recovery counters, read only. No customer PII.
SELECT
 (SELECT COUNT(*) FROM stripe_webhook_events e
  WHERE e.status IN ('RECEIVED','FAILED')
    AND e."receivedAt" < NOW() - INTERVAL '10 minutes')::text AS "staleSignedEvents",
 (SELECT COUNT(*) FROM tala_live_financial_cases c
  WHERE c.status <> 'resolved')::text AS "unresolvedFinancialCases",
 (SELECT COUNT(*) FROM orders o
  WHERE o.payment_method='stripe'
   AND o.payment_status IN ('paid','partially_refunded','refunded')
   AND NOT EXISTS(
    SELECT 1 FROM financial_ledger_entries l
    WHERE l.order_id=o.id AND l.account='stripe_live_collected'
     AND l.kind='stripe_live_payment' AND l.direction='credit'
     AND l.idempotency_key='order:'||o.id||':stripe-live:collected'
     AND l.currency='MXN' AND l.amount=o.total
   ))::text AS "suspectStripeCaptures",
 (SELECT COUNT(*) FROM orders o
  WHERE o.payment_method='stripe'
   AND o.payment_status IN ('paid','partially_refunded','refunded')
   AND (
    o.refunded_amount < 0 OR o.refunded_amount > o.total OR
    (o.payment_status='paid' AND o.refunded_amount<>0) OR
    (o.payment_status='refunded' AND o.refunded_amount<>o.total) OR
    (o.payment_status='partially_refunded' AND
       (o.refunded_amount<=0 OR o.refunded_amount>=o.total)) OR
    (COALESCE((SELECT SUM(l.amount) FROM financial_ledger_entries l
      WHERE l.order_id=o.id AND l.kind='stripe_live_refund'
       AND l.account='stripe_live_collected' AND l.direction='debit'),0) -
     COALESCE((SELECT SUM(l.amount) FROM financial_ledger_entries l
      WHERE l.order_id=o.id AND l.kind='stripe_live_refund_failure'
       AND l.account='stripe_live_collected' AND l.direction='credit'),0))
       <> o.refunded_amount
   ))::text AS "unreconciledRefunds",
 (SELECT COUNT(*) FROM orders o WHERE
   (o.payment_method='stripe' AND o.status='cancelled'
    AND o.payment_status='canceled' AND o.inventory_restored_at IS NULL) OR
   (o.payment_method='stripe' AND o.status='awaiting_payment'
    AND o.payment_status='pending' AND o.inventory_restored_at IS NOT NULL)
 )::text AS "invalidCancelledInventory",
 (SELECT COUNT(*) FROM orders o
  WHERE o.order_type='delivery' AND o.payment_method='cash'
   AND o.status='delivered' AND NOT EXISTS (
    SELECT 1 FROM delivery_proofs p
    WHERE p.order_id=o.id AND p.pin_verified=true AND p.driver_id=o.driver_id
   ))::text AS "cashDeliveryWithoutProof",
 (SELECT COUNT(*) FROM orders o
  WHERE o.order_type='delivery' AND o.payment_method='cash' AND o.status='delivered'
   AND (o.cash_collected<>o.total OR o.payment_status<>'paid'
    OR (SELECT COUNT(*) FROM financial_ledger_entries l
        WHERE l.order_id=o.id AND l.kind='cash_delivery_collection'
         AND l.account='cash_collected_by_driver'
         AND l.direction='credit' AND l.currency='MXN'
         AND l.idempotency_key='order:'||o.id||':cash-delivery:collected'
         AND l.amount=o.total)<>1)
 )::text AS "cashDeliveryCollectionMismatch",
 (SELECT COUNT(*) FROM orders o
  WHERE o.payment_method='stripe' AND o.payment_status='pending'
   AND o.payment_provider_id='pi_reserving_rc8_live'
   AND o.created_at < NOW() - INTERVAL '10 minutes')::text AS "stuckProviderReservations",
 (SELECT COUNT(*) FROM event_outbox o
  WHERE o.status='pending' AND o.created_at < NOW() - INTERVAL '10 minutes')
   ::text AS "staleOutbox",
 (SELECT COUNT(*) FROM orders o
  WHERE o.order_type='delivery' AND o.status='ready' AND o.driver_id IS NULL
   AND o.ready_at < NOW() - INTERVAL '10 minutes')::text AS "readyDeliveryWithoutDriver",
 (SELECT COUNT(*) FROM tala_live_treasury_withdrawals w
  WHERE w.state='unknown')::text AS "unknownTreasuryWithdrawals",
 (SELECT CASE WHEN EXISTS(SELECT 1 FROM orders o
  WHERE o.status IN ('delivered','cancelled')
   AND o.created_at >= NOW() - INTERVAL '30 days')
   THEN '1' ELSE '0' END)::text AS "hasObservedRealOrders"
