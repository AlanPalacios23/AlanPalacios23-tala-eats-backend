-- RC119 READ-ONLY operational HOLD diagnostics, aggregated counts only.
-- This is ONE SELECT with fixed predicates; it never exposes users, GPS, order IDs, or bank identifiers.
SELECT
(SELECT COUNT(*)::text FROM restaurants) AS "restaurantsTotal",
(SELECT COUNT(*)::text FROM restaurants WHERE verification_status='verified') AS "restaurantsVerified",
(SELECT COUNT(*)::text FROM restaurants WHERE verification_status='verified'
 AND onboarding_status='approved' AND is_open=true AND pickup_enabled=true
 AND delivery_radius_km>0 AND owner_id IS NOT NULL) AS "restaurantsCatalogCandidates",
(SELECT COUNT(*)::text FROM restaurants r JOIN users u ON u.id=r.owner_id
 WHERE r.verification_status='verified' AND r.onboarding_status='approved'
 AND r.is_open=true AND r.pickup_enabled=true AND r.delivery_radius_km>0
 AND u.is_active=true AND u.role='restaurant') AS "restaurantsWithActiveOwner",
(SELECT COUNT(*)::text FROM restaurants r JOIN users u ON u.id=r.owner_id
 JOIN tala_live_merchant_accounts m ON m.restaurant_id=r.id
 WHERE r.verification_status='verified' AND r.onboarding_status='approved'
 AND r.is_open=true AND r.pickup_enabled=true AND r.delivery_radius_km>0
 AND u.is_active=true AND u.role='restaurant'
 AND m.owner_approved_at IS NOT NULL
 AND m.stripe_account_id LIKE 'acct_%') AS "restaurantsOwnerConnectApproved",
(SELECT COUNT(*)::text FROM driver_profiles p JOIN users u ON u.id=p.user_id
 WHERE p.is_verified=true AND u.is_active=true AND u.role='driver') AS "driversAdminVerified",
(SELECT COUNT(*)::text FROM driver_profiles p JOIN users u ON u.id=p.user_id
 WHERE p.is_verified=true AND p.is_online=true
 AND u.is_active=true AND u.role='driver') AS "driversOnlineApproved",
(SELECT COUNT(*)::text FROM driver_profiles p JOIN users u ON u.id=p.user_id
 WHERE p.is_verified=true AND p.is_online=true
 AND u.is_active=true AND u.role='driver'
 AND NOT EXISTS(SELECT 1 FROM orders o WHERE o.driver_id=p.user_id
  AND o.status IN ('assigned','picked_up','on_the_way'))) AS "driversOnlineNotBusy",
(SELECT COUNT(*)::text FROM tala_live_driver_accounts d
 WHERE d.owner_approved_at IS NOT NULL) AS "driversConnectOwnerApproved",
(SELECT COUNT(*)::text FROM event_outbox WHERE status='pending'
 AND created_at < NOW() - INTERVAL '10 minutes') AS "outboxStalePending",
(SELECT COUNT(*)::text FROM event_outbox WHERE status='pending'
 AND created_at < NOW() - INTERVAL '10 minutes'
 AND attempts=0) AS "outboxStaleNeverAttempted",
(SELECT COUNT(*)::text FROM event_outbox WHERE status='pending'
 AND created_at < NOW() - INTERVAL '10 minutes'
 AND attempts>0) AS "outboxStalePreviouslyAttempted",
(SELECT COUNT(*)::text FROM event_outbox WHERE status='pending'
 AND created_at < NOW() - INTERVAL '10 minutes'
 AND event_type LIKE 'order.%') AS "outboxStaleOrderEvents",
(SELECT COUNT(*)::text FROM event_outbox WHERE status='pending'
 AND created_at < NOW() - INTERVAL '10 minutes'
 AND event_type NOT LIKE 'order.%') AS "outboxStaleOtherEvents",
(SELECT COUNT(*)::text FROM event_outbox WHERE status='retry'
 AND next_attempt_at <= NOW()) AS "outboxRetryDue",
(SELECT COUNT(*)::text FROM event_outbox WHERE status='dead_letter') AS "outboxDeadLetter"
