# TALA EATS — C2: cancelación y estados de restaurante en Node staging

**Estado:** PR #85 DRAFT apilada sobre #84 → #83 → #81 → #80. Fuente contractual Python: `backend/app/routes/orders.py` (`cancel`, `cancellation-preview`), `backend/app/routes/owner.py` (status), `backend/app/inventory.py`. Solo `tala_node_stage` / PG15 Redis8 CI efímeros. **NO desplegado a Kali y NO habilitar en producción.**

## Contratos parciales incorporados

- `GET /api/v1/orders/{id}/cancellation-preview` (customer/admin): calcula en centavos tarifa 0% `received`, 10% `confirmed`, 30% `preparing`, con respuestas de revisión para estados posteriores. Política aún parcial: no emite cobros de cancelación.
- `POST /api/v1/orders/{id}/cancel?reason=...` (customer/admin): solo pedidos cash/pickup C1 sin capturas, usuarios aislados, razón de longitud máxima 300, repetición idempotente sin doble restore ni ledger duplicado. Otros métodos, pedidos legacy sin huella HMAC, pedidos pagados, entregados o con datos corruptos devuelven error sin cambios.
- `PATCH /api/v1/owner/orders/{id}/status` (restaurant/admin): subset `received → confirmed → preparing → ready`, o `cancelled` en etapas previas. Valida propiedad del negocio. Futuros estados, dispatch, KDS mutante completo y confirmación de cobros siguen deshabilitados.
- Para una cancelación nueva se bloquea la fila `orders FOR UPDATE`, se verifica `inventory_restored_at IS NULL`, se reponen ítems ordenados y cantidades de ingredientes usando **el snapshot original**, no la receta que el comerciante pueda haber modificado.
- La misma transacción restaura inventario, marca `cancelled`, graba `cancelled_reason`, `cancellation_fee`, evento de orden, notificaciones, `event_outbox=pending` y asientos de reversión nuevos con claves únicas. El trigger PG impide modificar o borrar asientos previos.
- El pedido cash estaba `payment_status=pending`: **no existe efectivo capturado, reembolso ni cargo**. La tarifa por cancelación es dato informativo / contractual, no una deuda cobrada ni distribución de caja; los reversos anulan ingresos/obligaciones **contables sintéticos** del checkout C1. Los flujos reales de fee settlement requieren aprobación posterior.

## Pruebas obligatorias

Workflow `.github/workflows/tala-node-order-lifecycle-c2.yml` en PG15/Redis8 descartables:
1. Baselines de Python (252 rutas), Prisma migrations ordenadas C1 → C2, TypeScript y tests existentes.
2. Regresiones Auth, Marketplace, checkout C1 (carreras por stock y HMAC).
3. Nuevas pruebas C2: cancelación simultánea 6 veces, cross-account 404, owner RBAC 403, tasas preview 0/10/30, lifecycle `confirmed/preparing/ready`, cancelación del comercio sin fee, fallas de snapshot sin cambios y reintento válido, carrera cancel vs status.
4. Comprueba EXACTAMENTE una restauración por ítem e ingrediente, sólo un evento/cancel outbox y exactamente un conjunto de asientos reversos; el PIN no se comparte con comercios.
5. CI puede limpiar **solo** los keys de throttling `tala:node:v02:auth:rate:*` de Redis efímero entre suites para no mezclar el rate-limit de registros con pruebas C2. Está protegido por `GITHUB_ACTIONS=true` y loopback Redis; el código de seguridad de API no cambia.

## Bloqueos para paridad Python completa

- Cancelación/reembolso de `wallet`, gift card, corporativo, Stripe/MP TEST y movimientos/conciliación reales.
- Fee de cancelación por estado más allá del scope cash/pickup, cobro/compensación del fee, disputas, créditos/referrals/puntos.
- Estados de repartidor, entrega PIN/foto, merchant-managed, dispatch/geo/FCM, evento realtime y worker de outbox.
- Pruebas diferenciales JSON y Flutter Usuarios/Restaurante/Repartidor/ADMIN, load test, backup y restore reales de Kali, cutover con rollback.
- `STAGE_PICKUP_CASH_CHECKOUT_ENABLED=false` por defecto: sin bandera específica el flujo de mutaciones C2 responde 503. No ejecutar esta migración contra DB Python ni directamente en Kali.

**Veredicto:** C2 es una franja segura y comprobable de migración, **no** 1:1 ni release LIVE. Actualizar el checklist #82 sólo con el SHA cuyo CI complete `SUCCESS`.
