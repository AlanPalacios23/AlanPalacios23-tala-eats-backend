# TALA EATS · Paridad Python/FastAPI → Node/Express/Prisma

**Fuente canónica:** repositorio \`AlanPalacios23/AlanPalacios23-tala-eats-backend\`, rama \`main\`, commit \`7cf8ae3f4fce51b1265ad511bd4e36077fc42636\`; inspeccionadas las rutas de \`backend/app/routes/\`, \`backend/app/schemas.py\`, \`backend/app/models.py\`, \`backend/app/security.py\`, \`backend/app/deps.py\`.

**No sustituir el API productivo** con Node v0.1.0. No importar secretos ni datos productivos. GitHub PR v0.2.0 es aislada de la instancia que ya está funcionando en Kali. Una ruta homónima no implica paridad; sólo se marca PASS si coincide payload, estado HTTP, validaciones, autorización, permisos, efectos persistentes y regresiones cliente.

| Módulo Python | Prefijo API | Nº de rutas mapeadas | Estado Node |
|---|---|---:|---|
| Auth | /api/v1/auth | 12 | IN PROGRESS: 8 rutas de identidad implementadas, Google/config stub, OAuth/recuperación pendiente; CI PG15/Redis8 PASS |
| Restaurants | /api/v1/restaurants | 2 | PENDING |
| Orders | /api/v1/orders | 8 | PENDING, prioridad client_reference |
| Owner | /api/v1/owner | 12 | PENDING |
| Driver | /api/v1/driver | 9 | PENDING; conservar feature flag merchant-managed |
| Payments Mercado Pago | /api/v1/payments | 4 | PENDING; sin LIVE |
| Stripe payments | /api/v1/payments/stripe | 7 | PENDING; sin LIVE |
| Withdrawals / Connect | /api/v1/withdrawals | 7 | PENDING; TEST ONLY |
| Platform: addresses, wallet, notifications, etc | /api/v1/platform | 27 | PENDING |
| Admin | /api/v1/admin | 13 | PENDING |
| Operations / ledger / finance | /api/v1/operations | 38 | PENDING |
| V9: dispatch, 2FA, markets, effective-menu, etc | /api/v1/v9 | 62 | PENDING |
| V10: runtime and stability | /api/v1/v10 | 3 | PENDING |
| V11: mobile contract, KDS, offers, payouts, privacy | /api/v1/v11 | 28 | PENDING |
| Uploads | /api/v1/uploads | 9 | PENDING; private documents |
| Resilience: outbox, DLQ, reconciliation | /api/v1/resilience | 11 | PENDING |
| **Total of these inspected modules** | | **252** | No-Go for production |

> Counts are the Python route decorators inspected, not an assertion that every route is enabled in deployment. Modules registered in \`main.py\` may differ. Other endpoints (e.g. \`/ws/orders\`) require a separate inventory.

## Fase A — identidad, sin pagos
- Python \`RegisterRequest\` name(2..120), email, password(8..128); response \`AuthResponse\` contains access_token/token_type/user/device_token.
- Python \`UserPublic\` id(int), name, email, role, auth_provider, avatar_url, phone, is_active, two_factor_enabled, marketing_opt_in, analytics_opt_in, personalization_opt_in, birth_date.
- \`security.py\`: PBKDF2-HMAC-SHA256 **600000** iterations, salt **16 bytes**, SHA256 digest **32 bytes**, serialized \`pbkdf2_sha256$600000$BASE64_SALT$BASE64_DIGEST\`.
- Python JWT: HS256, sub stringified int, role, iat, exp, jti; device attestation \`typ=talaeats-device\` and SHA256 of X-Device-ID; TOTP SHA1/30s/6 digits ±1 timestep.
- Security boundary: device session sha256(token) persisted, jti must match a nonrevoked session on protected calls. HTTP-only session cookie \`talaeats_session\` SameSite=Lax; staging cookie secure false, production policy **must be explicitly hardened** before public switch.
- Python register also creates Tala Wallet/loyalty account, notification and welcome email; **never advertise registration as fully compatible until durable outbox, wallet defaults, email delivery and audit parity exist**. Google token verification and password recovery need external integrations and separate E2E.
- Avoid copying Python LIVE \`JWT_SECRET\`: staging must use a new, dedicated secret. Old users' JWTs must never authenticate on fresh staging.

## Fase B — core marketplace
- Restaurants, MenuItem from ORM use **numeric IDs**, not UUIDs. Monetary values are NUMERIC decimal, not JS floating-point for payment ledger.
- Orders support \`client_reference\` account-scoped uniqueness and exact recovery, order items/options, state transitions, stock, wallet, typed payment methods, business policies and event outbox.
- Merchant app: profile/address and lat/lng pair validation, KDS, stock, schedule; customer app: search/home, favorite/reorder; driver app: assignments, proof/PIN and earnings; Admin: privacy/role boundaries.
- Explicitly preserve \`cash\` and \`merchant-managed\` flow semantics. Do not invent weight pricing variants; separate 500g/1kg product representations when schema lacks price-per-variant.

## Fase C — finance and resiliency
- Preserve durable outbox, DLQ, immutable ledger, payment reconciliation, idempotency, refund/payout state machines and settlement permissions.
- Stripe SDK/Connect Express **TEST only** in staging; signed raw webhooks; no actual payout creation or automated blind retries.
- Financial schema migrations/backfills require separate approval, independently restored backups and current source/CI provenance.

## Acceptance gates
1. Contract fixture for every original endpoint: method, URL, status, response/request schemas, role policy.
2. Unit + integration PostgreSQL15 Redis8 and negative security tests in GitHub CI, pinned SHA.
3. Verify real Kali staging E2E, observability, backup + rollback proof.
4. Flutter Users, Restaurant, Driver and Admin compatibility smoke + no leakage of delivery PIN/financial fields.
5. No public DNS/API switch and no LIVE Stripe/PM2 auto-deploy until all gates PASS.

**This document is a tracked porting baseline, not a claim of complete replication.**
