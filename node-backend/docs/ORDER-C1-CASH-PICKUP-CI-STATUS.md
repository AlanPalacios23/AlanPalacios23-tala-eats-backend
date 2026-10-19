# TALA EATS · Fase C1 checkout Node — caja de pruebas cash/pickup atómica

**Estado:** PR #84 DRAFT apilada sobre #83 → #81 → #80. **CI PASS** en SHA `c6782c30ef9af0961e5476ff53ab012eced3a7a1` (push `39206069727`, PR `39206073492`). Sólo PostgreSQL 15/Redis 8 **efímeros** de GitHub Actions; **NO Kali, NO LIVE, NO producción**.

## Lo que replica realmente del Python

- `POST /api/v1/orders` restringido a **`payment_method=cash`, `order_type=pickup`** con `client_reference` obligatorio de 1–80 caracteres, cliente autenticado, cuenta customer/admin, restaurante abierto y pickup habilitado.
- La referencia es única por `(user_id,client_reference)`: un candado SQL `FOR UPDATE` en la fila del usuario serializa reintentos concurrentes. El primer pedido persiste HMAC SHA-256 del checkout validado en `order_events`; repetir la misma intención devuelve el mismo pedido, y cambios de intención con igual referencia devuelven HTTP409 **antes** de modificar stock, pagos o ledger.
- Filas de menú ordenadas por ID bloqueadas antes de evaluar precios, stock y disponibilidad. Decremento de stock por `UPDATE ... WHERE stock>=quantity ... RETURNING` y validación/deducción de recetas/ingredientes con tres decimales en filas bloqueadas. Una excepción revierte **toda** la transacción.
- Para la política Python v1.5.2 **por defecto** sin settings alterados (comisión 15%, service 7%, recogida sin delivery fee, propina íntegra a comercio): cálculo sólo con `BigInt` centavos y redondeo half-up. No se usan `number` flotantes JS para repartir dinero. Esto **no es** paridad de políticas v1.6.2, overrides comerciales ni tarifas delivery.
- Mismo commit transaccional escribe `orders`, `order_items` (snapshots de nombre, precio, opciones), `inventory_reserved_json`, `order_events`, evento `order_outbox` mapeado a `event_outbox` con `status=pending`, notificaciones y asientos `financial_ledger_entries` idempotentes. Los asientos tienen trigger PG que impide `UPDATE` y `DELETE`.
- Respuesta de pedido compatible con cliente en campos básicos, PIN del pedido visible **sólo en respuestas customer-facing**, y `Cache-Control: private, no-store`.

## Lo que sigue BLOQUEADO (NO-GO)

- `STAGE_PICKUP_CASH_CHECKOUT_ENABLED=false` por defecto. Requiere además `AUTH_V02_ENABLED=true` y `MARKETPLACE_B_ENABLED=true`, más JWT staging privado.
- `POST /orders` con delivery, pagos Stripe/MP, wallet/gift cards/corporate, cupones, menús de horarios/precios dinámicos, opciones con precios y otras capacidades no verificadas responde **503**, no crea pedidos.
- `client_reference` **obligatorio** en esta subfase aunque Python lo permite nulo. Paridad de contratos pendientes; una omisión no se convierte implícitamente en compra no idempotente.
- Los registros del ledger son **contables en staging**; no autorizan transferencias, cobros, liquidaciones ni movimientos bancarios. Ningún worker publica todavía `event_outbox` a sistemas externos.
- El bloqueo de stock es implementado, pero **restauración por cancelación/reembolso, eventos de cambio de estado, conciliación y KDS mutante todavía no**.
- Los valores comerciales de `SystemSetting`, motores v1.6.2, filtros de fraude, Plus, promociones, impuestos e idempotencia entre distintas versiones de contrato **no están integrados**. No habilitar cash en el dominio público mientras permanezcan diferencias.
- El backup/restore de Kali staging debe revisarse antes de ejecutar la migración nueva allí. La presencia de CI verde no autoriza cambiar Caddy, túnel, DNS, bases Python ni Stripe LIVE.

## Evidencia reproducible

Workflow `.github/workflows/tala-node-cash-pickup-atomic-e2e.yml`:
1. Node 24, `npm ci`, `prisma generate/validate`, migraciones nuevas exclusivamente en PG15 descartable.
2. Build TS y unit tests existentes; Redis 8 protegido con password efímero.
3. Scripts de Auth y Marketplace anteriores para regresión.
4. `ci-cash-pickup-atomic-e2e.mjs`: compras en efectivo, rechazo de tarjeta y delivery, RBAC, precios `25.50` con redondeo exacto, doble submit mismo usuario (4 concurrentes), referencia cambiada 409, dos compradores compitiendo por último producto/ingrediente (solo uno completa), ausencia de stock negativo, exactamente dos pedidos, dos eventos únicos, ledger inmutable y protección de PIN frente a comercio.
5. Restricción de secrets LIVE y cero uso de infraestructura Kali.

## Próximas fases antes de cerrar #82

- C2: política comercial configurable/versionada, impuestos, descuentos y fees de entrega exactos con distancia geográfica servidor; motor de disponibilidad/recetas completo; pruebas diferenciales Python/Node.
- C3: cancelación + restock idempotente de menú/ingredientes, ledger compensatorio, partial refunds y outbox/worker seguro.
- D: aceptación/transiciones restaurante, KDS real, dispatch concurrente al repartidor, PIN y foto de entrega (privacidad).
- E: Stripe/MP test firmado, conciliación, Wallet, payouts con aprobación aparte. Compatibilidad Flutter / ADMIN y pruebas reales de Kali staging tras respaldos.
- Sólo cuando todos los gates estén en PASS y exista aprobación explícita, planificar cutover Python→Node.

**No marcar `POST /orders` como 100% replicado**: sólo está probado el subconjunto cash/pickup en CI.
