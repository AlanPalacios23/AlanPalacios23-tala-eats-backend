# H3 — 200 de 252 firmas HTTP Python → Node.js 24

**Fecha:** 2026-10-19. Referencia Python: \`main@7cf8ae3f4fce51b1265ad511bd4e36077fc42636\`.

**Estado confirmado (código):** Node \`feat/node-first200-h3-20261019@4fb3fe78ed506caa0140a7d0dc5c5dee3885b185\`, GitHub Actions [push PASS #39309723034](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/39309723034) y [PR PASS #39309730255](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/39309730255).

- Python: **252** rutas HTTP en 16 módulos auditados.
- Node: **200** declaraciones Express montadas y coincidentes por método + ruta normalizada; **52 pendientes**.
- Cobertura **estructural de HTTP 79.37 %**. Esto **NO** significa 79.37 % de paridad funcional, calidad, seguridad, throughput, dinero ni infraestructura.
- H3 +13: V9 \`POST /admin/experiments\`, \`GET /admin/experiments\`, \`GET /experiments/active\` (asignación SHA256 y unicidad ante concurrencia); \`POST /admin/marketing/:automationId/run\` (marketing in-app, opt-in, límites y auditoría; email 503 sin worker); \`GET /admin/corporate/:accountId/statement\` (solo lectura); \`POST /admin/partner-keys\` / \`GET /partner/catalog\` (tokens **te_stage**, hash SHA-256, scope catalog:read exclusivamente); \`POST /security/2fa/setup\`, \`POST /security/2fa/confirm\`, \`POST /security/2fa/disable\` (TOTP real, auditoría, sin desactivar sin código); V11 \`POST /merchant/orders/:orderId/bump\` (cambios KDS transaccionales solo efectivo); V9 \`GET /admin/dispatch/:orderId/candidates\` y \`POST /admin/dispatch/:orderId/auto-assign\` (candidate ranking, bloqueo de perfil, una entrega activa y outbox atómico; efectivo/entrega únicamente).
- PG15 staging: tres tablas nuevas \`experiments\`, \`experiment_assignments\`, \`partner_api_keys\`; migraciones en CI desechable, NO en Kali.
- E2E dedicado \`ci-first200-h3-growth-security.mjs\` PASS: sticky A/B concurrente sin duplicados, cohortes/admin, marketing sólo consentido y antispam, llaves partner, estado empresarial y TOTP.
- E2E dedicado \`ci-first200-h3-kds-dispatch.mjs\` PASS: estados KDS permitidos, RBAC, motor de candidatos, entrega única por driver, outbox de asignación y **sin** asientos de pago.
- CI ejecuta todas las regresiones Auth → H3, incluyendo DB/Redis, checkout cash/pickup, drivers, soporte, F1 (35), G1 (26), G2 (20), G3 (20), H1 (12), H2 (9), H3 (13).
- **Importante:** no todos los 200 endpoints son implementaciones 1:1 del Python. Algunos son metadata/read-only o contratos más restrictivos por diseño para evitar mover dinero inseguramente. Faltan paridad plena de checkout delivery/MP/Stripe, conciliación y devoluciones parciales, WebSocket/pubsub, push transport, FCM, orquestación de entregas a escala, órdenes corporativas y operaciones de proveedores, tests Flutter/API, reconciliación/rollback y p95 real.
- **NO-GO LIVE**: PRs #80–#104 DRAFT apiladas; no merge ni cambios en Python V3/GREEN, datos reales, Kali, gateway, DNS ni Cloudflare. Ningún endpoint nuevo debe habilitarse frente a usuarios finales sin hardening, QA y plan de cutover.
- Checklist maestro: [Issue #82](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/82).

**Siguiente fase:** completar 52 rutas HTTP restantes, clasificar su criticidad por side effects y completar los subsistemas transversales (workers/realtime/PSP/controles que no cuentan como rutas) antes de considerar producción.
