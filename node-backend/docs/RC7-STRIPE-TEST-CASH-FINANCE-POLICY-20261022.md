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
- **Reembolsos/cancelaciones Stripe:** no hay compensación de inventario ni reembolso real integrados en Node RC7. Una orden que quede en `awaiting_payment` reserva stock; crear y probar expiración/cancelación segura antes de activar ni siquiera TEST con clientes externos.
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
