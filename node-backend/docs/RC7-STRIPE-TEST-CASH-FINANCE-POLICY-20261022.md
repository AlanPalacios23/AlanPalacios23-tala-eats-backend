# TALA EATS — RC7: efectivo, tarjeta Stripe TEST y política financiera Python

**Fecha:** 22-oct-2026 · **Estado:** rama de trabajo y QA, **NO autoriza LIVE**. Código sujeto a revisión de compilación, E2E y auditoría.  
**Backend operativo previo:** Node RC6 SHA `30ab51b587b21127c3f3419e0ec4c3a8539dfb0a`, Kali `127.0.0.1:18190`, dominio `https://talaeats.alan-palacios-dev.com/api/v1`. Esta rama **no** fue desplegada.

## Implementado en este corte

1. Pedido de **recoger + efectivo**: conserva el flujo sintético RC6 y su bandera `STAGE_PICKUP_CASH_CHECKOUT_ENABLED=false` por defecto.
2. Pedido de **recoger + Stripe TEST**: aprovecha stock transaccional, idempotencia por `client_reference`, y deja el pedido en `awaiting_payment` hasta confirmación del webhook. Nueva bandera `STAGE_STRIPE_TEST_CHECKOUT_ENABLED=false` por defecto, exige `sk_test_`, `pk_test_`, `whsec_`, autenticación y marketplace habilitados.
3. `POST /api/v1/payments/stripe/orders/:orderId/payment-intent`: solo comprador autenticado y dueño del pedido; monto y divisa MXN calculados en Node, clave de idempotencia fija derivada del pedido. Respuesta privada `client_secret` para Stripe PaymentSheet en la app de Usuarios. El backend nunca acepta importes arbitrarios del cliente.
4. `POST /api/v1/webhooks/stripe`: ruta preexistente con cuerpo raw y firma Stripe verificada; worker RC7 recupera el evento y el PaymentIntent directamente de Stripe TEST y solo marca la orden `paid` si corresponden cliente, importe, moneda, orden, ID de PaymentIntent y `amount_received`. Asientos inmutables TEST y outbox protegidos por candado PG.
5. `src/finance/pricing.ts`: reglas monetarias en centavos y redondeo `ROUND_HALF_UP` según `backend/app/monetization.py` histórico, para tarifas **estándar** `v152` y `v162`, con tests. No aplica políticas personalizadas ni calcula dinero real disponible para retirar.
6. Asistente `scripts/kali-stripe-test-secret-wizard.sh` disponible para ejecución posterior **solo por** `tala-node-stage`. Pide claves TEST sin imprimirlas, guarda con modo `0600`, mantiene LIVE y el checkout TEST **apagados**; no reinicia PM2 ni habilita ningún cobro.

### Robustecimiento posterior a la primera RC7 (en revisión)

- Se reserva en la base de datos `pi_reserving_rc7` **antes** de iniciar la llamada remota de creación del PaymentIntent. Una llamada de Stripe que agota el tiempo deja el pedido en revisión, sin liberar stock ni permitir otro PSP ID arbitrario. Las reejecuciones dentro de 30 minutos usan la misma clave de idempotencia; después, revisión manual.
- El comercio puede avanzar `received → confirmed → preparing → ready` **solo** si el pedido con tarjeta ya tiene `paymentStatus=paid` y un asiento `stripe_test_collected` firmado por el webhook; la entrega con PIN deja `cashCollected=0` si fue Stripe. El flujo cash mantiene el registro de efectivo separado.
- El comprador puede cancelar un TEST **no capturado** y recuperar inventario únicamente si la cancelación del proveedor quedó confirmada; cualquier ambigüedad o importe ya capturado continúa bloqueado para conciliación.
- No se ha completado el circuito de reembolsos de importes capturados, liquidaciones de caja, saldo retirable o pagos comerciales. El nuevo código permanece detrás de flags apagadas.

### RC7 — robustecimiento de cobros y diagnóstico (22-oct-2026)

- `allowed_payment_method_types=['card']` y `automatic_payment_methods.allow_redirects='never'` para la versión **stripe-node 23.0.0**: no se habilitan OXXO, transferencias diferidas ni métodos de redirección con esta app. El servidor mantiene monto MXN, cliente y estado final como autoridad.
- **Caducidad TEST conservadora:** el worker revisa como máximo 10 reservas de tarjeta para recoger con más de 35 minutos, nunca toca reservas cuyo PaymentIntent todavía se está creando, y llama al mismo flujo que verifica primero si Stripe confirma la cancelación. Solo entonces restaura stock; si la tarjeta fue capturada o el proveedor responde ambiguamente, conserva el pedido y exige conciliación manual. Esta función depende de la bandera TEST; no es un motor de expiración LIVE.
- **Bloqueo del dinero antes del cobro:** los pedidos Stripe TEST inicialmente solo reservan inventario y quedan en `awaiting_payment`; NO crean `gmv`, `restaurant_payable`, `platform_revenue` ni evento `order.created` para comerciantes. Después de un `payment_intent.succeeded` verificado, en una única transacción PG se marca `paid`, se asienta el cobro, se acreditan las cuentas contables (solo TEST), se crea el outbox y se notifica al comercio. Cancelar un TEST no capturado exige ledger vacío y no genera saldos negativos ficticios.
- `GET /api/v1/payments/stripe/orders/:orderId/status` requiere comprador autenticado, verifica propiedad y **asiento contable inmutable** antes de reportar `confirmed_by_server=true`. Nunca devuelve `client_secret`; ofrece `requires_manual_review` si el pedido figura pagado pero el ledger es inconsistente. PaymentSheet no confirma el estado del negocio por sí solo.
- El worker **NO** marca un evento de pago `PROCESSED` si la bandera Stripe TEST se desactivó durante un incidente. Conserva el recibo firmado en PostgreSQL y reintenta de modo acotado cuando se habilita nuevamente. Los reintentos están limitados a eventos recientes (48 horas, tandas de 20; 5 minutos después de agotarse los intentos) y no pueden realizar transferencias.
- Cancelaciones de pedidos no capturados: margen de contribución exactamente cero es válido; el ledger debe conservar cuentas críticas y no tener duplicados. Un pago capturado continúa requiriendo **reembolso** e investigación, nunca reverso simple de stock.
- `scripts/rc7-kali-finance-preflight.sh` ofrece verificación de solo lectura como `tala-node-stage`: estado de API local/pública, worker, base de datos, Redis, configuración privada y banderas LIVE apagadas. No solicita ni imprime secretos, no modifica la base de datos, no reinicia PM2 ni actualiza Cloudflare.
- Se añadieron pruebas de conservación de importes entre restaurante, repartidor y plataforma, además de pruebas regresivas de reintentos, protección de estado móvil y sintaxis de scripts.

**Activación de producción NO autoriza un simple cambio de variables.** RC7 sigue rechazando `NODE_ENV=production` y claves `sk_live_` por diseño. Para cobros reales hay que preparar y validar un runtime financiero LIVE por separado, probar con una cuenta Stripe TEST, comprobar reembolsos, conciliación, fiscalidad, recuperación, fraude, integridad de DB, permisos y contrato Flutter y aprobar explícitamente el corte. No desplegar este PR sobre RC6 sin esas puertas de seguridad.

### Verificación de la política histórica frente a la política comercial

| Elemento | Python `commercial_v152` | Python `commercial_v162` |
|---|---:|---:|
| Comisión comercio sobre comida neta | 15 % | 15 % |
| Tarifa cliente sobre comida neta, efectivo o Stripe | 7 % | 7 %, tope MXN 25 |
| Envío base | MXN 39 como mínimo frente a cotización del restaurante | MXN 35 (incluye 2 km), +MXN 5 por km extra |
| Remuneración repartidor | Al menos MXN 32 o 70 % del envío, el mayor | Igual, además MXN 32 + MXN 4/km por encima de 2 km, elegir mayor |
| Propina de pedido para recoger | 100 % restaurante | 100 % restaurante |
| Propina entrega con reparto plataforma | 100 % repartidor | 100 % repartidor |
| Coste Stripe | Estimación 3.6 % + MXN 3, más 16 % sobre el coste calculado | Misma estimación; **no es comisión efectiva ni liquidada** |

**Decisión pendiente de negocio:** la tarifa pública recordada de Tala Eats es envío base MXN 39, pero el **código Python v1.6.2** establece **MXN 35**. No habilitar efectivo/delivery real antes de confirmar la versión de tarifa que regirá los nuevos pedidos. El cálculo solo sirve si la configuración histórica no fue personalizada.

## Bloqueos NO-GO antes de aceptar fondos de usuarios

- **Stripe LIVE:** `STRIPE_FINANCIAL_WRITES_ENABLED=false`, `NODE_ENV=staging`, clave `sk_test_`; no usar claves `sk_live_` en este release ni publicar claves reales en GitHub.
- **Pedidos con tarjeta para entrega:** no desarrollados; solo se implementa el camino de pickup TEST. Pago con tarjeta en Delivery debe añadir cotización, GPS, stock, atribución y coordinación del worker.
- **Efectivo real y caja:** el checkout RC6 para pickup es sintético; las capturas de efectivo con repartidor, conciliación de caja, faltantes, contracargos administrativos y liquidación a comerciantes aún requieren pruebas y lógica.
- **Cancelaciones Stripe TEST:** se añadió cancelación por el comprador **solo antes de captura**. Cancela primero el PaymentIntent TEST si existe, comprueba estado `canceled` y después restaura stock, revierte asientos e invalida el pedido dentro de la misma transacción PG. Si la creación del PaymentIntent está en progreso o el PSP no responde de forma inequívoca, **mantiene inventario retenido** y exige conciliación; no se ejecutan devoluciones de un pago capturado. **Siguen pendientes** expiración automática segura, reembolsos, evidencia E2E de carreras y resolver pedidos abandonados. El flujo NO autoriza LIVE.
- **Finanzas:** el libro se utiliza para observación TEST; no es prueba de conciliación final. Verificar evento duplicado, fuera de orden, fallos de Stripe, DB, Redis y reinicio PM2. El importe de comisión de Stripe es **estimado**.
- **Stripe Connect:** `/withdrawals`, onboarding, transferencias, saldos y payouts siguen rechazando operaciones monetarias, sin mostrar ganancias de efectivo como saldo Stripe retirables.
- **App Usuarios:** `production_api.dart` aún contiene el método Mercado Pago legado. Eliminarlo y probar Stripe PaymentSheet en builds de QA antes de distribuir nuevas APK/AAB.
- **MFA, auditoría e historial:** no reutilizar tokens/credenciales del backend Python, no usar el repositorio público como repositorio de secretos y restringir flujos GitHub Actions que alcancen Kali.

## Pruebas requeridas para promover etapa RC7

1. GitHub: `npm ci && npm run generate && npm run db:validate && npm run build && npm test`. Workflows E2E PG15/Redis8/500 compras deben terminar `SUCCESS` para el SHA de merge.
2. Kali: promover SHA fijo con procedimiento RC6/RC7 por usuario `tala-node-stage` y copia nueva, PG backup/restore aislado; nunca modificar código PM2 activo.
3. En entorno TEST aislado, wizard `bash scripts/kali-stripe-test-secret-wizard.sh --plan` y, **tras aprobación**, `--apply`. Nunca enviar secretos en chat ni en logs.
4. Configurar Stripe Dashboard **TEST** con webhook `https://talaeats.alan-palacios-dev.com/api/v1/webhooks/stripe`, eventos de PaymentIntent, validar firma real con `whsec_`. Primero pruebas sin habilitar banderas.
5. Integración Flutter QA: crear orden pickup Stripe TEST, abrir PaymentSheet, simular aprobado/rechazado, verificar webhook duplicado, orden aislada, auditoría, devolución y stock. No aceptar tarjetas reales en este release.

### Notas de seguridad y versionado

- El script de claves no debe ejecutarse desde GitHub Actions, ni sustituir el `.env` del sistema por una copia de CI.
- El SHA de GitHub no altera el SHA que se ejecuta en Kali. Publicar una nueva rama o PR **no activa** ninguna forma de pago.
- Este documento no declara `productionReady=true` ni confirma que los pagos reales estén preparados; la revisión financiera y las pruebas de restauración siguen siendo obligatorias.
