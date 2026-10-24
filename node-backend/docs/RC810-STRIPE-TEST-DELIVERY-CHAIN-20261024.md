# TALA EATS RC8.10 — pago Stripe TEST a domicilio, restaurante → repartidor → entrega

**Estado:** implementación experimental sólo **staging**, **apagada por defecto**, sin cobros LIVE, sin Connect, sin deploy Kali ni versión pública Play. Extiende RC8.9 (#153), RC8.8 (#152) y RC8.7 (#149).

## Alcance real

- Nueva bandera `STAGE_DELIVERY_STRIPE_TEST_ENABLED=false`, permitida sólo en `NODE_ENV=staging` con `STAGE_DELIVERY_CASH_CHECKOUT_ENABLED=true`, `STAGE_DRIVER_DELIVERY_ENABLED=true`, `STAGE_STRIPE_TEST_CHECKOUT_ENABLED=true`, secretos únicamente Stripe TEST, sin escrituras LIVE ni Connect.
- `POST /orders/delivery-quote`: subtotal, servicio, envío, propina, total calculados en servidor usando coordenadas y radio + repartidor verificado, cerca y con heartbeat GPS. Soporta `cash` y, **sólo cuando se habilita Stripe TEST**, `stripe`.
- `POST /orders`: reserva inventario con transacción e idempotencia; Stripe mantiene `awaiting_payment`/`pending` hasta webhook real firmado, NO notifica ni expone al restaurante antes de pagar.
- `POST /payments/stripe/orders/:id/payment-intent`: sólo comprador del pedido, mismo importe exacto de servidor, metadatos `rc810_test_delivery`, ID/idempotency key conservados. Stripe TEST usa PaymentSheet y jamás claves LIVE.
- `/webhooks/stripe` firmado + `processStripeTestReceipt`: confirma importe, titular, `mode`, PaymentIntent, referencia y recibo con estado `succeeded`. Dentro de una única transacción cambia `payment_status=paid`, crea asiento `stripe_test_collected`, devenga restaurante, repartidor, plataforma y costes TEST; inserta evento/outbox/avisos. **Sin webhook válido, no se cobra ni libera pedido desde la app.**
- Restaurante `/owner/orders` y `/owner/kds` sólo muestran pedidos tarjeta con ledger inmutable `stripe_test_payment` de importe exacto; rechazan estado `paid` sin recibo. Secuencia `received → confirmed → preparing → ready` exige el mismo recibo.
- Dispatcher con bloqueo de fila selecciona exclusivamente repartidores verificados, conectados y cerca, tras `ready`; para tarjeta exige `stripe_test_collected` exacto. Worker reintenta READY y auditor RC8.9 incluye pedidos tarjeta confirmados atascados.
- Repartidor `assigned → picked_up → on_the_way → delivered` con PIN. Para tarjeta el pago ya permanece `paid` y `cash_collected=0`; **nunca crea asiento `cash_delivery_collection`**. No marca dinero disponible para retiro.
- Reserva tarjeta TEST sin pagar tras 35 minutos: job de expiración valida primero con proveedor que el PaymentIntent no fue capturado; sólo entonces cancela y restaura inventario. Ante resultado ambiguo, HOLD, sin reembolso automático inventado.
- Flutter Usuarios v1.0.46 sólo ofrece tarjeta a domicilio si el backend declara `delivery_stripe_supported=true`; muestra total del servidor, revalida antes de confirmar y usa PaymentSheet y consulta autenticada al servidor.

## Pruebas y alcance

1. `rc810-stripe-test-delivery-gates.yml`: pruebas unitarias, compilación TypeScript, migraciones PG15, cash delivery completo con worker real y control de pagos LIVE OFF.
2. `rc810-synthetic-paid-delivery-e2e.yml`: crea pedidos tarjeta en PG15 desechable con credenciales TEST **ficticias** (sin Stripe externo); prueba que pending no llega a Restaurante, que `paid` sin ledger y ledger de monto incorrecto son rechazados en checkout/KDS, y que **otro** pedido con estado de webhook sintético correcto completa PIN sin cobrar efectivo. El libro contable es inmutable y por diseño el test no corrige ni borra asientos.
3. Esta segunda prueba **NO acredita haber cobrado/consultado un PaymentIntent real** ni haber recibido un webhook firmado real de Stripe. Es una prueba de transición y controles financieros tras el estado de conciliación. Se requiere Stripe TEST externo y prueba de firma real antes de habilitar la bandera en Kali.
4. Mobile QA tres apps Flutter: análisis, tests y APK DEBUG únicamente; no AAB firmada ni Play Console.

## NO-GO comercial / pasos necesarios

- Test Stripe TEST externo con credenciales protegidas en Kali staging, evento firmado `payment_intent.succeeded`, reintento de evento y rechazo de falsificación, Stripe Dashboard comprobable sin mover dinero LIVE.
- Caso tarjeta rechazada, cancelación antes de captura, caída del worker entre callback y asiento, reintentos; reembolsos y disputas de tarjeta tras captura deben tener flujo autorizado. Si no, bloqueo de lanzamiento.
- Prueba de 3 apps **en dispositivos** contra Kali: sesión, GPS, PaymentSheet, aceptación, KDS, repartidor, PIN, historial y notificaciones reales Firebase background.
- Validar tarifa vial antes de ofertarla como kilómetros de conducción; actual cálculo geodésico no representa tráfico/calles.
- Verificar elegibilidad y consentimiento Connect de comercio y repartidor, conciliación de comisiones reales, efectivo y liquidaciones. No transferencias automáticas aún.
- Backup/restore y postdeploy auditor del **SHA exacto instalado** con rollback y sin tocar producción vigente. Cambios apilados todavía como PR borradores.

**Jamás promocionar esta rama al entorno LIVE por el mero resultado PASS del CI.** El flujo de pago de verdad a domicilio permanece **NO-GO** hasta cerrar las pruebas externas y financieras anteriores.
