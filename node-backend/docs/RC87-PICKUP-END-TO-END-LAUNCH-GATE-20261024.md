# TALA EATS — RC8.7 · Primer pedido íntegro y verificable (24-oct-2026)

**Estado:** código candidato en PR #146, todavía **DRAFT / NO DESPLEGADO / SIN AUTORIZACIÓN PARA COBROS**. La app Usuarios v1.0.44 está en PR mobile #64. RC8.6 #144 es la base encadenada. La rama main conserva el backend Python histórico. No confundir CI verde con pruebas en el servidor Kali.

## Objetivo comercial mínimo y único
**Cliente crea pedido pickup → efectivo al recoger o Stripe capturado y conciliado → restaurante confirma → preparando → listo → PIN válido y entrega → saldo y operación contabilizados.**

No se anuncia delivery, despacho real ni transferencias automáticas Stripe Connect. El primer lanzamiento comercial no depende de implementarlos, pero **no se puede anunciar reparto**.

## Contratos reales del cliente Android
1. GET `/api/v1/orders/payment-methods`: método efectivo/tarjeta habilitado por **estado real** del backend; `pickup_quote_supported=true`, `delivery_checkout_supported=false`; prueba contra los flags del servidor y no contra UI hardcoded.
2. POST `/api/v1/orders/quote`: login de cliente, precios/stock desde PostgreSQL, `total`, `service_fee`, `quote_is_binding=false`, **no crea pedido**. Revalidación en servidor al insertar la orden.
3. POST `/api/v1/orders`: `client_reference` persistente por cliente; respuesta 201 con importes reales; reintento idéntico recupera el mismo ID sin descontar stock dos veces.
4. GET `/api/v1/orders/by-reference/{reference}`: recuperar tras timeout/reinicio sin nuevo pedido, inventario ni cargo.
5. Tarjeta: POST `/api/v1/payments/stripe/orders/{id}/payment-intent` y PaymentSheet. **PaymentSheet completada no significa pago aprobado**. Únicamente webhook Stripe firmado y recuperación del evento confirmado cambian `awaiting_payment/pending` a `received/paid`. El restaurante NO ve pedido pagable antes.
6. Restaurante: PATCH `/api/v1/owner/orders/{id}/status` para `received→confirmed→preparing→ready`, solo dueño autenticado, con recibo Stripe exacto para tarjeta.
7. Recogida: POST `/api/v1/owner/orders/{id}/complete` con PIN y sesión comercio. Transición final `delivered`, idempotencia, prueba en PostgreSQL, loyalty/outbox. Efectivo se registra como `cash_pickup_collection` / `cash_collected_by_merchant`, **nunca como saldo Stripe disponible**.

## Auditoría de dinero
- Política pickup por defecto: comercio 15 % de productos, cliente 7 % sobre subtotal elegible; v1.6.2 tope de $25 MXN; envío $0 y propinas no comisionadas.
- Para Stripe: comparar captura remota de Stripe con `orders.total`, usuario, pedido, modo `livemode`, moneda MXN e ID PI. Conciliación firmada, idempotente y transactional en PostgreSQL.
- `contribution_margin` negativo legítimo = débito, no una excepción que pierda el pedido; `platform_revenue - payment_processing_fee = contribution_margin`, cálculos enteros.
- Los importes `payment_processing_fee` son **estimaciones de procesamiento**, no el coste final facturado por Stripe. No declarar utilidad neta conciliada hasta obtener tarifas definitivas y ajustes.
- `restaurant_payable` no es `available_for_withdrawal`. Stripe Connect transferencias automáticas **OFF**; la retención/revisión y liquidación manual se conservan explícitas.

## Matriz P0 para una prueba real (sin saltos)
| Paso | Prueba obligatoria |
| --- | --- |
| Datos y runtime | PostgreSQL LIVE independiente con migraciones y backup/restore PASS; Redis LIVE independiente, mismo par PM2 público, `/health` y `/ready` con SHA exacto |
| Comercio | Cuenta real (NO The Burger House temporal), dueño autenticado, Connect mexicano propio, KYC completo, transfers/payouts habilitados en su cuenta; autorización `owner_approved_at` legítima |
| Cliente Android | AAB/App debug SHA versionado, login real, catálogo, vista previa coincidente, pedido idempotente, cliente puede recuperar por referencia |
| Stripe TEST | 1 compra tarjeta con fondos ficticios, reenvío de webhook firmado, recibo único, margen positivo/negativo, restaurante sólo ve pedido después de `paid` |
| Stripe LIVE | Un cargo de importe pequeño **explícitamente autorizado** al comercio real, webhook verificado, prueba de reembolso/disputa, ledger y retries; no basta `charges_enabled=true` plataforma |
| Restaurante/entrega | Móvil comercio acepta/prepara/listo, PIN válido, pedido `delivered`, outbox/notificaciones in-app y cash ledger, sin dobles cargos con refresh/reintento |
| Regresiones | 4 suites Node PG15+Redis8, CI LIVE PG15 webhook sintético, Flutter analyze/tests APK debug, pruebas dispositivo y QA 320–430dp; conexión Firebase push real aún por verificar |
| Operación | Plan exacto sin efectos, respaldo restaurable, switch manual con autorización explícita, smoke Cloudflare, monitoreo y rollback; reembolsos/disputas en HOLD si no tienen compensación |

## GO / NO-GO
**NO-GO si cualquiera de estos puntos falta:** comercio real con Connect aprobado; configuración Stripe LIVE y webhook completo; integración Android firmada y probada; prueba de compra real autorizada y conciliada; migraciones/backups/worker correctos; soporte y procedimiento de refund; entrega PIN + contabilidad verificadas en mismo runtime.

No instalar claves en GitHub ni compartirlas por chat. Los scripts `--plan` son para auditoría sin cambios. **No ejecutar `--apply` hasta cerrar y autorizar el checklist.** No modificar el PostgreSQL de staging para aceptar dinero real.

**Referencias:** backend #146 sobre #144 y Usuarios #64 sobre #63. Las cuatro suites CI anteriores de RC8.7 se ejecutaron con 500 compras sintéticas; una prueba heredada de aislamiento RC8 exige erróneamente que `app.ts` no importe LIVE en una rama que ya tiene composición LIVE explícita. Resolver con un gate adaptado a la arquitectura actual, nunca suprimiendo la comprobación de que las claves TEST y LIVE estén aisladas.
