# Tala Eats — RC8.3 PM2 LIVE Pickup candidate (23-oct-2026)

**Código integrado en GitHub; NO desplegado, ni autorizado para cobrar aún.** Esta candidata reúne rutas existentes, pedido para recoger y Stripe LIVE en el mismo runtime Node/PM2. Las garantías financieras sin verificar se mantienen como bloqueos de activación; los servicios existentes de Kali permanecen intactos.

## Alcance real

- **Una sola API pública**: `src/server.ts` + `src/app.ts`, misma URL `https://talaeats.alan-palacios-dev.com/api/v1`, mismo host loopback `127.0.0.1:18190`.
- **Dos procesos PM2 existentes**, sin nuevos servicios públicos: `tala-node-stage-api` y `tala-node-stage-worker`. En producción el worker apunta a `dist/live/production-worker.js` desde `ecosystem.production.config.cjs`.
- **Operaciones soportadas en código**: pedidos **pickup/recoger** en efectivo o tarjeta, precios y comisiones del backend, stock reservado transaccionalmente, Stripe PaymentIntent LIVE con idempotencia, pago pendiente hasta webhook firmado y ledger ACID, estado verificado para Flutter Usuarios, cancelación de PI con 0 capturado, reembolsos y refunds fallidos contabilizados, disputas retenidas y barridos del worker.
- **Rutas Flutter compatibles**: `POST /api/v1/orders`, `POST /api/v1/payments/stripe/orders/:id/payment-intent`, `GET /api/v1/payments/stripe/orders/:id/status`.
- **Webhook Stripe LIVE ya registrado**: `POST /api/v1/payments/stripe/webhook` (firma Stripe y cuerpo bruto, durable inbox PostgreSQL).
- **Datos independientes de staging**: `NODE_ENV=production`, `DATABASE_URL` y `REDIS_URL` con usuario/instancia distinto a staging; no se permite el PG `15435/tala_node_stage` ni Redis stage `16379/0`.
- **Manual HOLD**: SIN transferencias Connect ni retiros automáticos; cualquier refund/disputa exige revisión. Los reembolsos pueden realizarse desde Stripe Dashboard y el worker concilia los eventos; no existe endpoint público de refund automático.
- **Scope excluido**: delivery real con repartidor, preferencias financieras avanzadas, combinaciones/cupones/variantes dinámicas, settlement automático y la equivalencia funcional completa con Python para pedidos delivery. El producto general **no** debe anunciarse apto para todos los tipos de pedido.

## Archivo privado de entorno (solo cuando se autorice Kali)

Wizard que **no activa cobros** y no imprime secretos:
`node-backend/scripts/kali-rc83-live-env-wizard.py`.

El wizard solicita `DATABASE_URL` (PG productivo), `REDIS_URL` (Redis productivo), `AUTH_JWT_SECRET` separado de staging, `STRIPE_SECRET_KEY` LIVE, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`. Crea `/home/tala-node-stage/.config/talaeats-node-live.env` con modo `0600`.

Los interruptores permanecen **false**: `STRIPE_LIVE_ENABLED`, `STRIPE_LIVE_RELEASE_APPROVED`, `STRIPE_FINANCIAL_WRITES_ENABLED`, `STRIPE_REFUNDS_ENABLED`, `STRIPE_MANUAL_SETTLEMENT_APPROVED`, `STRIPE_CONNECT_TRANSFERS_ENABLED`. El archivo creado NO arranca porque el guard de producción necesita una aprobación explícita posterior. Este bloqueo es intencionado.

## Ruta de una sola promoción PM2 (futura, sin ejecución)

1. Congelar SHA exacto y verificar 4 workflows CI: Stripe/Node PG15/Redis8, ADMIN MFA, 500 compras sintéticas y RC6 staging. Verificar expresamente tests RC8.3 de configuración LIVE y contrato Flutter.
2. **Antes de cualquier cambio:** exportar respaldo comprobado de datos, Redis y PM2; verificar restauración real, migraciones de la base de datos **productiva** y usuarios existentes. No apuntar claves LIVE a PostgreSQL de staging, ni iniciar una segunda API pública.
3. Completar verificación comercial de cuenta Stripe principal y Connect; asegurar suscripción a refund.created/updated/failed y charge.dispute.created/closed, además de PaymentIntent y charge.refunded. El webhook LIVE debe mantener URL actual y secreto whsec original.
4. Provisionar env con wizard privado. Validar conexión read-only Stripe con `scripts/stripe-live-account-check.mjs`. **No copiar el archivo a chat, logs ni GitHub.**
5. Realizar QA integrado sobre **base productiva provisionada y aislada con servidor no público** (solo validación fuera de banda): creación de orden real de importe pequeño, importe correcto, error de tarjeta, captura, firma webhook, ledger, conciliación, refund parcial/completo, error de refund, disputa, reinicio y doble entrega de evento. Para cargar dinero real requiere autorización específica y deben acordarse reembolsos.
6. Solo entonces, con checklist GO explícito, habilitar interruptores de Stripe LIVE/finanzas bajo operador y realizar promoción **sobre nombres PM2 existentes** con la configuración `ecosystem.production.config.cjs`. No lanzar procesos PM2 nuevos.
7. Ejecutar `scripts/rc8-postdeploy-audit.mjs --mode live <SHA_EXACTO>`; verificar que source, proceso, rutas API local y público, worker heartbeat y Stripe están alineados. Vigilar errores, saldo, webhook delivery, pedidos y reversos.
8. Ante un fallo, detener nuevos cobros **sin perder webhooks ni idempotency keys**; investigar transacciones en curso antes de restaurar la release anterior.

## Control de lanzamiento actual

**PREPRODUCTION_CODE_CANDIDATE=YES**, sujeto a CI del SHA exacto.
**PRODUCTION_DEPLOYED=NO. CUSTOMER_LIVE_CHARGES_VERIFIED=NO.**
**MANUAL_MERCHANT_SETTLEMENT_SIGNOFF=NOT_VERIFIED.**
**CONNECT_PAYOUTS=DISABLED/PENDING_ONBOARDING.**
**FULL_DELIVERY_AND_MARKETPLACE_PARITY=NOT_IMPLEMENTED.**
**COMMERCIAL_GO_LIVE=NO-GO** hasta pruebas reales y firma de aprobación operativa. Las suites sintéticas CI no validan cobros bancarios reales ni restitución de producción.

El módulo `scripts/release-readiness.mjs --production` continúa anunciando PRODUCTION_NO_GO por diseño: será reemplazado por el gate final únicamente después de comprobar los requisitos externos y operativos. No marcar el deploy como PASS solo porque compile.
