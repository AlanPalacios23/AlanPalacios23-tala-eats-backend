# RC12.8 — Solo Stripe TEST: transferencia, retiro y conciliación firmada

**Producción NO se desbloquea en esta versión.** RC12.8 no debe integrarse ni desplegarse hasta que sus pruebas estén verdes. No usar restaurantes, conductores, claves o base de datos LIVE como fixtures.

## Estado real y límites

- RC12.6 está desplegado en Kali; RC12.7 repara el límite histórico de 100 transferencias.
- RC12.8 reutiliza `recordTreasuryTransferReview`, `dispatchTreasuryTransfer`, `reserveTreasuryWithdrawal`, `approveTreasuryWithdrawal`, `dispatchTreasuryWithdrawal`, `recoverUnknownTreasuryPayout` y el conciliador Connect ya existentes.
- TEST firma eventos con el SDK real; las pruebas de GitHub usan respuestas de Stripe simuladas para no solicitar credenciales ni mover fondos.
- Para probar una operación real en TEST, se necesita una clave `sk_test_`, cuentas Connect TEST con capacidades habilitadas, recursos de un pedido entregado TEST, y saldos TEST disponibles. La integración disponible en este chat solo expone el modo LIVE; **no se probó una llamada remota TEST todavía**.
- No presentar `submitted` como `paid`. Solo un evento Connect firmado y la lectura remota permiten registrar `bank_payout_paid` una vez.

## Ejecución supervisada en Kali — etapa aislada, nunca producción

Requisitos antes de operar: el repositorio debe estar en el commit RC12.8 exacto, `npm ci` y `npm run build` correctos, Node 24, servicio Unix `tala-node-stage`, base `tala_node_stage` en 127.0.0.1:15435, Redis de staging en 16379, todas las banderas financieras LIVE explícitamente en `false`, y `STRIPE_SECRET_KEY` privada que comienza por `sk_test_`. No utilizar aquí el archivo `talaeats-node-live.env`.

La variable `STAGE_ENV` debe apuntar al archivo **privado** de staging. Nunca pegar ni subir su contenido.

```bash
# PLAN: solo SELECT y lecturas Stripe TEST. No mueve fondos.
node --env-file="$STAGE_ENV" scripts/rc128-stripe-test-treasury-execution.mjs --plan transfer <RESERVATION_ID>
node --env-file="$STAGE_ENV" scripts/rc128-stripe-test-treasury-execution.mjs --plan payout <WITHDRAWAL_ID>
```

Solo si los dos planes muestran PASS, el beneficiario TEST tiene saldo TEST y existen autorizaciones distintas:

```bash
node --env-file="$STAGE_ENV" scripts/rc128-stripe-test-treasury-execution.mjs --execute-test transfer <RESERVATION_ID> I_APPROVE_STRIPE_TEST_TRANSFER_ONLY
node --env-file="$STAGE_ENV" scripts/rc128-stripe-test-treasury-execution.mjs --execute-test payout <WITHDRAWAL_ID> I_APPROVE_STRIPE_TEST_PAYOUT_ONLY
```

Estos comandos llaman realmente a Stripe, **pero únicamente al entorno TEST**. Los ids y las credenciales deben existir antes en staging; el script no inventa un comerciante ni valida un Stripe LIVE. El retiro solo alcanza `SUBMITTED` hasta recibir confirmación.

Para recuperar una respuesta de red perdida SIN otro cargo/transferencia:

```bash
node --env-file="$STAGE_ENV" scripts/rc128-stripe-test-treasury-execution.mjs --recover-test transfer <RESERVATION_ID> I_APPROVE_STRIPE_TEST_RECOVERY_ONLY
node --env-file="$STAGE_ENV" scripts/rc128-stripe-test-treasury-execution.mjs --recover-test payout <WITHDRAWAL_ID> I_APPROVE_STRIPE_TEST_RECOVERY_ONLY
```

### Webhook TEST Connect — HTTP local, no Cloudflared

El receptor TEST escucha solo en `127.0.0.1:18193`. Necesita `STRIPE_CONNECT_WEBHOOK_SECRET` con el secreto privado `whsec_` correspondiente a la sesión Stripe CLI, distinto del secreto webhook de la plataforma. Debe arrancarse después de obtener ese secreto y NO se monta en la API LIVE.

```bash
node --env-file="$STAGE_ENV" scripts/rc128-stripe-test-connect-webhook-listener.mjs --listen-test I_APPROVE_STRIPE_TEST_SIGNED_RECONCILIATION_ONLY
```

Desde Stripe CLI en modo TEST, reenviar los eventos Connect firmados a:
`http://127.0.0.1:18193/api/v1/webhooks/stripe-connect`.

El receptor verifica el HMAC y el estado remoto de payout; escribe únicamente el recibo y la conciliación en PostgreSQL staging, nunca crea pagos. Los eventos inválidos no se contabilizan. Si hay estado `unknown`, investigar la cuenta Connect TEST usando el identificador ORIGINAL: nunca lanzar una segunda operación.

## Obligatorio antes de LIVE

1. Prueba de pago Stripe TEST firmado -> restaurante acepta -> entrega PIN -> distribución contable exacta.
2. Transferencia de comisión y beneficiarios en TEST con clave original/idempotencia, y recuperación con timeout simulado.
3. Retiro TEST de restaurante y driver por separado, MFA, dos ADMIN, banco de TEST, webhook real firmado, `paid` exactamente una vez.
4. Pruebas de cancelaciones, reembolsos, disputas, fondos insuficientes y reversas, incluyendo posibles eventos desordenados.
5. Backup/restauración aislada, alertas recibidas, rollback y autorización independiente de producción.
6. **No** activar `NODE_TREASURY_LIVE_EXECUTION_ENABLED`, `STRIPE_CONNECT_TRANSFERS_ENABLED`, ni banderas LIVE de delivery mediante este ensayo.

No generar ni copiar una clave Stripe LIVE a los archivos TEST.
