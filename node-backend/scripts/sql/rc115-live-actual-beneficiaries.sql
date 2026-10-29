-- RC115 READ-ONLY REAL PAYEE MAPPINGS. Never selects old merchant_connect_accounts.
SELECT 'restaurant'::text AS payee_kind,
 m.restaurant_id::text AS payee_id,
 m.stripe_account_id,
 (m.owner_approved_at IS NOT NULL) AS owner_approved,
 (r.owner_id IS NOT NULL AND u.is_active IS TRUE AND u.role='restaurant'
  AND r.verification_status='verified') AS payee_active,
 lower(u.email)::text AS identity_email
FROM tala_live_merchant_accounts m
JOIN restaurants r ON r.id=m.restaurant_id
LEFT JOIN users u ON u.id=r.owner_id
UNION ALL
SELECT 'driver'::text AS payee_kind,
 d.user_id::text AS payee_id,
 d.stripe_account_id,
 (d.owner_approved_at IS NOT NULL) AS owner_approved,
 (p.is_verified IS TRUE AND u.is_active IS TRUE AND u.role='driver') AS payee_active,
 lower(u.email)::text AS identity_email
FROM tala_live_driver_accounts d
JOIN users u ON u.id=d.user_id
JOIN driver_profiles p ON p.user_id=d.user_id
ORDER BY payee_kind,payee_id
LIMIT 51
