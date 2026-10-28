# Tala Eats RC9.5 — entrega a domicilio LIVE (GO/NO-GO)
Fecha: 2026-10-28. Fuente revisada: `0c8d92fa62ae910843b3d4c764da85a852b17085`
**Estado: HOLD para LIVE delivery; no efectuar despliegue ni cambiar flags.**

## Qué mantiene funcionando
- API pública RC9.4 y PM2 worker financiero, PostgreSQL/Redis de LIVE.
- Recogida en tienda Stripe LIVE existente.
- Recuperación por Resend y auth de las tres apps.
- Stripe Connect y retiros reales en OFF.

## Bloqueos detectados sobre el código efectivamente desplegado
1. `src/config.ts` prohíbe flags `STAGE_DRIVER_DELIVERY_ENABLED`,
   `STAGE_DELIVERY_CASH_CHECKOUT_ENABLED` y `STAGE_DELIVERY_STRIPE_TEST_ENABLED`
   en producción. Encenderlos allí puede impedir el arranque.
2. `src/marketplace/routes.ts` y `checkout.ts` solo permiten
   Stripe LIVE para **pickup**. DELIVERY cobra o crea pedidos solamente
   en el laboratorio de staging.
3. `driver.ts` usa llaves `tala:node:stage:driver:...` y el guard
   de conductor en staging. Debe existir un namespace LIVE independiente
   con TTL de ubicación y exclusión por driver.
4. `lifecycle.ts` solo intenta dispatch de READY en staging.
   `production-worker.ts` no tiene recuperación durable de READY→driver.
5. `delivery-financial-proof.ts` solo confía en recibos Stripe TEST.
   Para tarjeta LIVE requiere PaymentIntent Stripe LIVE capturado,
   webhook firmado, importe íntegro, ledger, refund/disputa y no una
   bandera `paymentStatus=paid` proporcionada por cliente.
6. **No hay evidencia** de PaymentIntent real TEST + webhook firmado
   real y flujo completo en los tres Android contra servidor con
   GPS/PIN, reintentos, caos de worker, rescate manual de pedidos READY.
7. Efectivo físico en poder del repartidor ≠ fondos de Stripe Connect.
   Falta política de deuda de efectivo/conciliación, soporte y
   reembolsos/disputas antes de activación general.

## Plan de implementación para próxima release
Fase A: contrato de cotización de entrega en LIVE con `delivery_supported=false`
hasta que exista disponibilidad real; rutas de reparto aisladas en Redis
`tala:node:live:driver:<id>:location`, usuario verificado y activo,
idempotencia + TTL + cola de reconducción. No aceptar pedidos prematuramente.

Fase B: entrega en efectivo (piloto limitado) con recibo contable de
cobro físico, aceptación explícita por repartidor, READY redelivery
en worker, actualización de cliente, PIN antifuerza-bruta y conciliación
manual segura. Pruebas sobre PostgreSQL/Redis de staging y tres APK.

Fase C: tarjeta a domicilio: Stripe TEST real + webhook firmado,
contabilidad exacta, fallos/timeout/reintentos y anomalías,
antes de crear un nuevo flag de **LIVE DELIVERY** independiente
de los flags staging y aprobación explícita. Mantener recogida LIVE intacta.

Fase D: rollout canario geográfico (Tala), uno o dos comercios de prueba,
repartidores aprobados, tope diario, monitoreo de READY sin asignar,
alarma y apagado rápido de nuevas órdenes; conservar órdenes en
curso en el worker y soporte manual.

## Auditoría no destructiva
La rama incluye:
`node-backend/scripts/rc95-live-delivery-readiness-audit.mjs`
- `--source` valida que los bloqueos siguen activos, sin red ni credenciales;
  sale con código 2 porque dice HOLD, no porque haya una falla de CI.
- `--live` debe ejecutarse manualmente con usuario `tala-node-stage`,
  desde el release RC9.4 activo y el entorno privado, validando PM2,
  rutas /ready, y conteos agregados de comercios/repartidores. **No**
  escribe datos ni llama a Stripe. También sale con código 2 por HOLD.

**No liberar LIVE DELIVERY mediante un cambio de .env.**
La fuente RC9.4 desplegada mantiene todos los bloqueos a propósito.
