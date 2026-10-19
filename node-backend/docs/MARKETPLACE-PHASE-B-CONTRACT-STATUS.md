# TALA EATS — Node Phase B: Marketplace Python contract delta (staging only)

**Source:** Python `main@7cf8ae3f4fce51b1265ad511bd4e36077fc42636`, `backend/app/{routes/{restaurants,orders,owner,driver}.py,models.py,schemas.py}`.
**Stack:** Node 24 / Express / TypeScript / Prisma 7 / PostgreSQL15 / Redis8 / PM2 (Kali user `tala-node-stage`, no Docker for this stage). Branch/PR: `feat/node-marketplace-parity-stage-b-20261019` / #83, stacked on #81 > #80.

## Actual implemented API routes (not full 1:1 parity)

| Group | Python route | Node stage | Evidence target | Remaining delta |
|---|---|---|---|---|
| Catalog | GET /api/v1/restaurants | Implemented | PG15 REST E2E | Python Redis cache TTL 20, effective menu, markets v9 |
| Catalog | GET /api/v1/restaurants/{id} | Implemented incl. menu sort | E2E | Cache invalidation, runtime availability |
| Owner | GET /api/v1/owner/restaurant | Implemented + RBAC | E2E | Owner middleware/admin special cases |
| Owner | POST /api/v1/owner/menu | Implemented + validations/DECIMAL | E2E | Availability/pricing schedule runtime evaluation |
| Owner | PATCH /api/v1/owner/menu/{id} | Implemented + RBAC | E2E | Order impact, cache invalidation |
| Owner | DELETE /api/v1/owner/menu/{id} | Protected when referenced by existing order | E2E | Difference vs Python FK SET NULL documented intentionally |
| Owner | PATCH /api/v1/owner/restaurant | Implemented location pair, address, ownership | E2E | Cache invalidation, validation minor parity |
| Owner | GET /api/v1/owner/orders | Read-only, operational JSON excludes PIN | E2E | KDS, order management and transitions |
| Orders | GET /api/v1/orders/by-reference/{ref} | Implemented account-scoped, private/no-store | E2E | Read-only, no order recreation |
| Orders | GET /api/v1/orders/mine | Implemented paginated | E2E | Exact optional fields, stable ordering |
| Orders | GET /api/v1/orders/{id} | Implemented RBAC, PIN customer-only | E2E | Complete driver GPS/optional fields |
| Orders | POST /api/v1/orders/{id}/reorder | Implemented: returns cart items without checkout | E2E | No payment writes; items missing from menu excluded |
| Owner | GET /api/v1/owner/kds | Implemented read-only, cash/paid gate, scheduled lead time + no PIN | E2E | Status actions and dispatch not yet enabled |
| Driver | GET /api/v1/driver/available | Implemented read-only: driver online, no active job; no PIN | E2E | Cannot enable online via API until safe assignment parity |
| Orders | POST /api/v1/orders | **503 deliberate** (fail closed) | E2E | Atomic stock/reservation, invoices, provider state, fees, idempotent paid checkout, gift/wallet and outbox all P0 |
| Driver | GET /api/v1/driver/profile | Implemented stage read model | E2E | Merchant-managed global 410 mode |
| Driver | GET /api/v1/driver/mine | Implemented read-only, no PIN | E2E | Dispatch, active delivery flow |
| Driver | PATCH /api/v1/driver/availability | **503 deliberate** | E2E | Atomic dispatch and active-order gating |
| Driver | PATCH /api/v1/driver/location | **503 deliberate** | E2E | Redis realtime + geo coalescing, privacy protections |

**Not implemented:** orders cancel/cancellation-preview, owner analytics/status/complete/employees, driver dashboard/accept/status/complete, full order lifecycle, provider payments, public marketplace markets filter. These remain in master checklist #82.

## Data model

`20261019_marketplace_phase_b` creates only **new** isolated staging PostgreSQL15 tables `restaurants`, `menu_items`, `driver_profiles`, `orders`, `order_items` after Phase A Auth migration. Numeric IDs and `DECIMAL(10,2)` financial snapshots reflect Python. `orders` uses composite uniqueness `(user_id,client_reference)`. No checkout logic or ledger mutations, no payouts. Existing Python tables/databases are never touched.

## GitHub Actions evidence

- Phase B after adding non-mutating reorder/KDS/available reads: commit `b28f98be37f37f5b3a4f5b6b3d3fb6d16ad1bd37` — [push PG15/Redis8 E2E SUCCESS](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/39204941482), [PR PG15/Redis8 E2E SUCCESS](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/39204945877). No Kali or LIVE deployment.
- Any subsequent commit needs its **own** passing SHA before acceptance; previous PASS never transfers automatically.

## Security gates and staging

- Defaults: `MARKETPLACE_B_ENABLED=false`, requires `AUTH_V02_ENABLED=true` and a **unique staging JWT secret**; both guards enabled only in ephemeral CI at this stage.
- All sessions are checked against token signature and nonrevoked session in PG15. Owner/driver RBAC must use session role, never supplied `owner_id`.
- `GET /orders/by-reference/{ref}` does not reveal other users' existence (same 404), never calls PSP; response is `private, no-store`.
- Owner/admin/driver operational order responses omit `delivery_pin`. Customer order responses include it as the Python contract does.
- Public `GET /restaurants` retrieves synthetic/staging data only (no seeded demo records automatically).
- Owner menu delete is intentionally blocked if order history refers to item: until safe parity/retention policy review, no broken historic line items.
- Test script `ci-marketplace-contract-e2e.mjs` writes **synthetic fixture data only inside disposable GitHub Actions PG15**. Do not run it in the real Kali stage.

## No-Go Kali and release gates

1. Workflow `tala-node-marketplace-contract-e2e.yml` PASS in the PR final SHA, including Prisma migration, npm/TS tests, PG15/Redis8 HTTP contract, tenant isolation and zero financial writes.
2. Compare differential JSON of Python vs Node for every implemented endpoint; align trailing decimal zeros, cache policy, JSON serialization, pagination and errors for four apps.
3. Before staging Kali changes: backup/restore the isolated `tala_node_stage` and verify applied migrations, disk, ports and current PM2 health. Never run `migrate reset` or any SQL against Python V3/GREEN.
4. Continue implementing order create/stock/fees/ledger/idempotency and driver assignment exclusively in development + disposable CI, with tests including simultaneous checkout, retries, lost network response and Redis failure.
5. Finally validate all 252 Python HTTP routes plus other surface (WS/jobs/uploads/FCM), Flutter 3 apps and ADMIN against an isolated staged SHA. Only then consider an explicitly approved traffic cutover.

**This PR is a safe incremental implementation, not readiness to replace Python.** No action on public DNS/Cloudflare Tunnel, Stripe LIVE, bank accounts, Caddy or existing production.
