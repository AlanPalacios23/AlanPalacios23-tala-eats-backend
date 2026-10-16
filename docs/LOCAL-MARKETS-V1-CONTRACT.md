# TALA EATS · Local markets catalog — incremental backend contract (proposed)

**Scope:** compatible read filters and admin assignment only. No production deploy, migrations, pricing, delivery, payouts, checkout, account roles, or app merges.

## API contract

The existing `GET /api/v1/restaurants` keeps all its legacy behavior when no new query parameters are supplied.

Optional filters (applied in SQL **before** `offset`/`limit`):

| Parameter | Example | Behavior |
| --- | --- | --- |
| `market_code` | `AMECA-JAL` | Exact market, normalized to uppercase, no fallback to Tala |
| `cuisine` | `Carnicería` | Exact current establishment-type text, case-insensitive |
| `pickup_only` | `true` | Only merchants with Pickup enabled |
| `limit`, `offset` | `20`, `0` | Existing pagination, unchanged |

Examples:

```http
GET /api/v1/restaurants?market_code=TALA-JAL&limit=20&offset=0
GET /api/v1/restaurants?market_code=AMECA-JAL&cuisine=Carnicer%C3%ADa&pickup_only=true
GET /api/v1/restaurants
```

The public `GET /api/v1/v9/markets` route remains available to list markets that contain open merchants.

Admin-only assignment, using the existing Operations router:

```http
PATCH /api/v1/operations/admin/restaurants/{restaurant_id}/market
Authorization: Bearer <admin-test-token>
Content-Type: application/json

{"market_code":"AMECA-JAL"}
```

A successful assignment changes only the merchant's existing `market_code` and invalidates the catalog cache. It does **not** move GPS coordinates, change delivery ranges, alter prices or enable a business.

## Planned regional markets (codes, NOT enabled deployments)

| Locality | Suggested code |
| --- | --- |
| Tala | `TALA-JAL` |
| Cuisillos | `CUISILLOS-JAL` |
| Ameca | `AMECA-JAL` |
| Ahualulco de Mercado | `AHUALULCO-JAL` |
| Tequila | `TEQUILA-JAL` |
| Amatitán | `AMATITAN-JAL` |

Cuisillos is a locality within Tala municipality but may have its own shopping market when operations support it. Do not assume a municipality necessarily equals one unique commerce zone.

## Android Usuarios integration — NOT included in this backend PR

1. Ask for location permission; handle refusal and location services unavailable without blocking the app.
2. Resolve GPS to a **verified configured locality / market code** using an approved geocoding or bounded-region source. Do not infer from the nearest restaurant or Tala's default coordinates.
3. Send `market_code` in public catalog requests and preserve the same filter in all pagination, search and category screens.
4. Allow explicit manual city selection; a manually selected market takes precedence until user switches back to automatic. Provide safe handling outside supported markets and a clear empty state.
5. Show only local merchants in the selected market; delivery is still validated separately at checkout by actual customer coordinates and each merchant's radius. Pickup has no delivery fee when supported by that merchant.
6. Do not fetch all markets and filter only in Flutter; server-filter before paginating. Keep legacy API access available for older app versions until rollout.
7. Existing `cuisine` is a text field, not a normalized category taxonomy. Until a reviewed mapping exists, use consistent labels and verify category grouping on Android. Nonfood merchant commissions require separate policy approval.

## Safety and QA gate

- Confirm `main` parity with live Kali before any deployment (repo main is **not** proof of live version).
- Run `pytest backend/tests/test_local_market_catalog_v1.py` inside the backend test environment; run the full Python suite and PostgreSQL / Redis checks in isolated QA.
- Check older Android clients still load and paginate the unfiltered list.
- Validate admin-only assignment, market isolation, stable pagination, cache separation and cross-city pickup/delivery distinctions.
- No automatic city detection is claimed completed by this PR. GPS/locality UI and Android E2E tests are required separately.
- Do not operate live payments or merchant withdrawals during testing.
