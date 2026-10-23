# RC7 — Contrato de pagos para Usuarios, Restaurante y Repartidor

**Estado:** solamente código de desarrollo / staging Stripe TEST. No garantiza integración comercial, no despliega Kali, ni autoriza cobros LIVE o retiros. **Cero credenciales reales en GitHub.**

## Modelo financiero para TALA EATS

- Un pedido puede tener un restaurante, un repartidor y la plataforma. El cliente paga una vez; los beneficiarios reciben montos **después de entrega, conciliación y verificación**.
- Para tarjetas con distribución a varios beneficiarios y transferencias posteriores a la entrega, evaluar **Stripe Connect con cargos y transferencias separados**. Las transferencias se crean sobre **cuentas conectadas verificadas** y la transacción cobrada, usando `transfer_group` para correlación y `source_transaction` cuando corresponda. **`transfer_group` por sí solo NO reserva ni protege fondos**; `source_transaction` ayuda a vincular disponibilidad al cargo.
- No incluir `application_fee_amount` en cargos y transferencias separados: la plataforma retiene su comisión al calcular montos netos de transferencia.
- Una cuenta conectada de **Stripe Accounts v2** para destinatarios debe usar `configuration.recipient` y verificar **`configuration.recipient.capabilities.stripe_balance.stripe_transfers.status === 'active'`** antes de transferir. No decidir solo por `charges_enabled` o `payouts_enabled` de API v1.
- Para los negocios/repartidores: elegir experiencia Express y onboarding hospedado/embedded, con `notification_banner`, sujeto a habilitación de Connect para la plataforma y evaluación contractual. No crear cuentas ni solicitar datos KYC desde RC7.
- Los retiros exigen KYC, fondos disponibles, saldos no disputados, reserva para devoluciones, captura o entrega confirmada, historial financiero, idempotencia de transferencias, webhook y conciliación de Stripe; los ingresos en efectivo no son dinero ingresado a Stripe.
- La plataforma asume el tratamiento de comisiones Stripe, reembolsos y disputas del patrón elegido, con revisión fiscal/legal y financiera en México antes de LIVE. **No es un servicio de custodia/escrow legal**.

## App Usuarios (Flutter)

| Paso | API Node | Comportamiento seguro |
| --- | --- | --- |
| Mostrar botones | `GET /api/v1/orders/payment-methods`, `GET /api/v1/payments/stripe/config` | Usar solamente flags devueltos. No inferir que existen métodos habilitados solo por HTTP 200. |
| Efectivo para recoger | `POST /api/v1/orders` con `order_type=pickup`, `payment_method=cash` | Flujos actuales únicamente sintéticos / staging. No mostrar una confirmación de pago en efectivo antes de recepción con PIN. |
| Tarjeta para recoger | `POST /api/v1/orders` con `payment_method=stripe`, después `POST /api/v1/payments/stripe/orders/:id/payment-intent` | La API calcula el monto; la app jamás envía importe libre al proveedor. PaymentSheet solo ve `pk_test_` y `client_secret` del pedido propio. No hay clave secreta en Flutter. |
| Confirmación | `GET /api/v1/payments/stripe/orders/:id/status` | `confirmed_by_server=true` requiere también asiento contable verificado. Tras cerrar PaymentSheet, esperar la verificación por servidor. |
| Cancelar no cobrado | `POST /api/v1/orders/:id/cancel` | Puede devolver 409/503 si existe riesgo de captura o Stripe no confirmó cancelación. Mostrar soporte, jamás cancelar localmente el pedido. |

No reutilizar checkout Mercado Pago legado ni habilitar pagos por tarjeta a domicilio con esta rama. Stripe LIVE está **bloqueado**.

## App Restaurante (Flutter)

- La lista de pedidos no debe habilitar confirmación/preparación de un pedido `stripe` con `payment_status=pending` o `status=awaiting_payment`.
- Solo después del webhook Stripe TEST y el asiento contable, el pedido pasa a `received`, luego `confirmed → preparing → ready → delivered`.
- Para recoger, el PIN se verifica en Node. `cashCollected` NO aumenta en un pedido pagado con Stripe. Las propinas siguen su destinatario según tipo de entrega.
- `GET /api/v1/withdrawals/restaurant/:id/balance` devuelve `available_for_withdrawal=0.00` y `eligible=false` en RC7. `earnings_preview` informa montos históricos **pendientes de conciliación**, NO ganancias disponibles en Stripe. Si `earnings_preview=null`, la muestra excede el límite y hay que paginar/conciliar.
- `GET /api/v1/withdrawals/restaurant/:id/connect/status` identifica API v2, onboarding pendiente y `withdrawals_enabled=false`. La app debe bloquear retiro aunque el comercio tenga ventas en efectivo.

## App Repartidor (Flutter)

- Los flujos de despacho y pago de entregas comerciales **no están habilitados** en esta RC7. No confundir la remuneración teórica con una liquidación completada.
- `GET /api/v1/withdrawals/driver/:id/balance` usa la misma semántica de no disponibilidad; `pending_review_cash` es **dinero pendiente de cuadrar con la caja**, no balance Stripe Connect.
- Solo cuando exista entrega confirmada, recibos conciliados, cuenta Connect v2 activa y fondos disponibles se permitirá pedir retiro.
- Evitar un botón con acción operativa mientras el servidor rechace `POST /api/v1/withdrawals/:role/:id/request` con 503.

## Seguridad en Kali y cuentas Stripe

- El conector Stripe de esta sesión mostró **únicamente contexto LIVE**; no ejecutar API de escritura ni cobros conectados por el asistente. Crear/provisionar sandbox independiente desde Dashboard/CLI con autorización del titular.
- Para RC7 TEST se recomienda clave restringida `rk_test_` con permisos mínimos; el wizard también acepta `sk_test_` como retrocompatibilidad. Asignar solo los accesos realmente necesarios de PaymentIntents (lectura/escritura) y Events (lectura). La firma `whsec_` del webhook es independiente; `pk_test_` puede usarse en la app.
- Los secretos se capturan directamente en Kali por script, se guardan privados 0600, no se incluyen en GitHub Actions ni se pasan por mensajes. Habilitar bandera TEST solo tras transacción integral simulada e inspección de logs.
- No reutilizar el entorno `NODE_ENV=staging` ni modificar un literal de código para permitir `sk_live_`. El camino LIVE requiere su propio release/revisión, restauración probada, contabilidad y protección contra fraude.
- Vigilar además los 3 proyectos ajenos en Kali y preservar `talaeats-legacy-backups`, los 5 volúmenes Python de PG16/medios y la infraestructura Cloudflared.

## Gates aún pendientes de salida

1. Cobro Stripe TEST real extremo a extremo (incluidas tarjetas 3DS, cancelaciones, duplicados y pérdida de red).
2. Rembolsos capturados, disputas y recuperación idempotente en fallo de red/proveedor.
3. Efectivo **a domicilio**, conciliación del dinero en poder del repartidor y pagos al comercio.
4. Stripe Connect Accounts v2 (KYC, onboarding, transferencias posteriores, retiro, estados y reversos) — actualmente no operativo.
5. Aplicaciones Flutter (Usuarios, Restaurante y Repartidor) verificadas contra el contrato API y pruebas de Play Store.
6. Políticas comerciales finales (envío base MXN 35 histórico Python v1.6.2 versus MXN 39 de la política de negocio), impuestos, comisiones, alertas, límites, rollback y autorización LIVE.

Stripe referencia: https://docs.stripe.com/connect/marketplace/tasks/accept-payment/separate-charges-and-transfers y https://docs.stripe.com/connect/accounts-v2/connected-account-configuration .
