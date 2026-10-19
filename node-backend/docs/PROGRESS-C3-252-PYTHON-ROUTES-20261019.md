# Migración Python → Node.js: avance verificable al 19/oct/2026 (Fase C3)

**Estado:** código de PR #86 DRAFT, encadenado sobre #85 → #84 → #83 → #81 → #80. Fuente Python `main@7cf8ae3f4fce51b1265ad511bd4e36077fc42636`. No se ha mezclado a `main` ni aplicado a Kali.

## Cobertura real de la superficie HTTP

Ejecutar `python3 node-backend/scripts/python_route_inventory.py --check` y `python3 node-backend/scripts/node_route_coverage.py --check` desde la raíz del repositorio (o `python3 scripts/...` desde `node-backend`):

- **252 rutas HTTP** declaradas en Python, dentro de 16 módulos examinados.
- **35 declaraciones Express** en Node (`src/auth/routes.ts` + `src/marketplace/routes.ts`).
- **35/252 firmas de ruta con coincidencia estructural** (verbo + path normalizado, nombres de `{param}` vs `:param` no importan).
- **217 firmas Python sin declaración Node**. `35/252 = 13.9 %` es cobertura estructural **NO** porcentaje de funcionalidad ni paridad integral.
- Coincidencia por módulo: auth 12/12, restaurants 2/2, orders 7/8, owner 9/12, driver 5/9; los módulos restantes contienen la mayor parte de las rutas sin réplica declarada.
- Muchas declaraciones Node están intencionalmente parciales o bloqueadas: Google real, Stripe/MP LIVE, disponibilidad y ubicación del repartidor, múltiples contratos de checkout, pagos y liquidaciones.

El script `node_route_coverage.py` es análisis estático de código, sin red ni credenciales. CI falla si aparecen rutas Node no presentes en la superficie Python. **Esto no reemplaza E2E de contratos** (estructura JSON, validación, permisos, latencia, concurrencia y efectos secundarios).

## C3 entregado en código con evidencia de pruebas

**Endpoint:** `POST /api/v1/owner/orders/{id}/complete` para **`cash` + `pickup` sintético** de C1, únicamente con `STAGE_PICKUP_CASH_CHECKOUT_ENABLED=true` en PG15/Redis8 efímeros; en cualquier otro ambiente el flag queda `false`.

- Comprueba restaurante dueño o admin, estado READY y PIN de 4 dígitos. Redis aplica 5 intentos por pedido+actor/15min; falla cerrado sin Redis; respuesta owner omite PIN.
- Requiere huella HMAC del checkout de C1 antes de cerrar; excluye pedidos legacy, delivery y proveedores de pagos.
- Una sola transacción bloquea pedido y cuenta de fidelidad y conserva de forma idempotente `status=delivered`, `payment_status=paid`, `cash_collected` **únicamente simulado**, `delivery_proofs` con UNIQUE `order_id`, evento, outbox pending, registro de actividad, 2 notificaciones y puntos/racha/tier.
- Puntos como Python: `max(1,int(total // 10))`; tiers BRONZE/SILVER/GOLD/BLACK; racha por fecha UTC. No implementa referidos ni pagos reales.
- E2E prueba PIN inválido, roles equivocados, estado anterior a ready, tres completes simultáneos (solo una recompensa), 5 intentos fallidos y 429 posterior, puntos 4→8, racha 1→2, sin revelar PIN a owner, una prueba/outbox/evento por pedido, regresiones de Auth, catálogo, checkout y cancelaciones.

**Evidencia del código y del inventario automático:** SHA `af14414ea3eccad682c90c52c0102039248b67da` [CI push](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/39208442353), sujeto a PASS en la revisión de PR. El último commit documental debe revalidarse por separado.

## Roadmap pendiente antes de tráfico productivo

1. **P0 — Checkout integral:** pedido delivery geolocalizado, horarios/precios dinámicos, menús por ingredientes, fee engine de v1.5.2/v1.6.2 con `SystemSetting`, cupones/Plus/gift/wallet/corporativo y cierres de caja reales; no confundir `cash_collected` simulado con cobranzas verificadas.
2. **P0 — Dinero:** Stripe/Mercado Pago **TEST**, webhooks firmados/anti-replay, pasarela idempotente, refunds, ledger/settlement/payouts, retiros y reconciliación; no escribir LIVE automáticamente.
3. **P0 — Entregas:** estado realtime, ubicación Redis, asignación sin carreras, verificación PIN/foto, flujos repartidor/merchant-managed, KDS íntegro, FCM.
4. **P1 — Plataforma/ADMIN:** operaciones, auditoría, seguridad, multi-mercados Tala/Ameca/etc., usuarios, promociones, notificaciones, preferencias, soporte y analytics.
5. **P1 — Extensiones:** `v9` (62), `v10` (3), `v11` (28), resilience (11), uploads (9), endpoints de finanzas y workers/cron/WebSocket no contados en 252.
6. **P0 — Release:** contratos diferenciales Python/Node con fixtures y datos anonimizados, pruebas reales de las tres apps Flutter + ADMIN, rendimiento, fallo PG/Redis/worker, migración ensayada/backup/restore y rollback en staging Kali aislado.
7. **P0 — Aprobar cutover:** verificación de estado Python y Kali, congelación de datos, plan reversible con aprobación operativa. Hasta entonces NO-GO producción, Cloudflare, DNS, Stripe LIVE y retiros.

**Veredicto:** 35 rutas estructurales ≠ 35 rutas terminadas. El porcentaje funcional real no se puede expresar honradamente como 13.9 %, ya que esos endpoints contienen implementaciones parciales y flags desactivados. La mayor parte de la migración integral sigue pendiente.
