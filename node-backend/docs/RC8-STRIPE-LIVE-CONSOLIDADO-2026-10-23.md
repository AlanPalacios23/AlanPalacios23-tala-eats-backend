# Tala Eats — RC8 Stripe LIVE: paquete consolidado de ingeniería (23-oct-2026)

> **Estado:** desarrollo en GitHub, **NO-GO para cobros reales**. Este documento registra cambios y bloqueos verificables; no sirve como autorización para editar Kali, PM2 ni Stripe LIVE. 
>
> **Solicitud vigente:** terminar código en GitHub antes de desplegar una sola release sobre la API PM2 pública existente. Prohibido desplegar por separado otro backend/puerto público o volver a Docker.

## 1. Identidad, fuentes y restricciones

| Elemento | Valor |
| --- | --- |
| Repositorio | `AlanPalacios23/AlanPalacios23-tala-eats-backend` |
| PR base RC8 ingeniería | [#135](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/pull/135) — draft |
| PR consolidación | [#139](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/pull/139) — draft |
| Rama consolidación | `feat/node-rc8-stripe-live-preflight-20261023` |
| Host público existente | `https://talaeats.alan-palacios-dev.com/api/v1` |
| Instancia activa reportada desde Kali | Node RC8 SHA `c2737fa23c6cc8aeebddef01883b815ca5a6d594` en `127.0.0.1:18190` |
| PM2 existente | `tala-node-stage-api`, `tala-node-stage-worker`; conservarlos durante promoción |
| `ready` reportado por el operador | `ready=true`, `environment=staging`, `productionReady=false`, `financialWrites=false`, `onlinePaymentsEnabled=false` |
| Stripe plataforma | `acct_1UB69APUp8Tz0qUa` (lectura LIVE: `charges_enabled=true`, `payouts_enabled=true`, `card_payments=active`) |
| Stripe Connect | `acct_1UTm0lBmsG4BQXBD` (lectura LIVE: `charges_enabled=false`, `payouts_enabled=false`, `transfers=inactive`) |
| Endpoint LIVE registrado | `we_1UOhKXPUp8Tz0qUa0WZSyi68`, activo en `/api/v1/payments/stripe/webhook` |

La cuenta Connect tiene requisitos de alta pendientes. Una cuenta Connect creada **no** implica que pueda recibir transferencias ni liquidaciones.

## 2. Cambios acumulados del PR #139

| Componente | Implementación |
| --- | --- |
| `scripts/kali-stripe-live-credentials.py` | captura oculta y guardado atómico en archivo LIVE privado `0600`; banderas de cobro = `false` |
| `scripts/stripe-live-account-check.mjs` | lecturas GET de cuenta principal y Connect; verifica también destino LIVE y suscripción de webhooks; no inicia pagos |
| `scripts/stripe-live-preflight.mjs` | controles de preflight que fallan ante reembolsos/producción no acreditados |
| `src/live/stripe-payments.ts` | conserva configuración PaymentIntent compatible con SDK Stripe v23 (se detectó y corrigió TS2561 en una revisión anterior) |
| `src/live/postgres-store.ts` | permite reservar atómicamente pedidos con puntero de PI vacío o `NULL` |
| `src/live/reconcile.ts` | coteja la identidad de eventos remotos y bloquea eventos Connect fuera del flujo |
| `src/live/isolated-app.ts` y `src/live/webhook-router.ts` | soportan el webhook original de Stripe y el alias canónico, siempre con cuerpo bruto y firma |
| `src/live/financial-readiness.ts` | auditoría incluye pedidos `paid`, `partially_refunded` y `refunded`, y exige que los reembolsos estén conciliados en el ledger |
| `src/live/refund-reconciliation.ts` | Reconciliación de reembolsos LIVE ya confirmados por Stripe mediante evento duradero y API; débito idempotente de fondos cobrados, saldo reembolsado y evento de revisión. **No** inicia devoluciones ni libera inventario/pagos a comercios. |
| `src/live/webhook-inbox.ts` / `src/live/worker-runner.ts` | Barrido limitado de recibos `refund.created` / `refund.updated` con reintentos y retención segura; sucesos de disputa continúan bloqueados hasta implementar el resto del ciclo. |
| Pruebas `rc8-live-*.test.mjs` | reglas de webhook, sintaxis de instalador, fail-closed, auditoría financiera |

**La rama RC8 base todavía NO conecta un checkout financiero LIVE operativo al runtime público**. El módulo `isolated-app` exige `refundsEnabled=true` para activar checkout, y `guard.ts` aún no permite declarar reembolsos implementados. Es correcto que falle cerrado mientras falta compensación.

## 3. Webhook LIVE: faltan eventos necesarios en Stripe

La consulta real a Stripe devolvió un endpoint habilitado con:

- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `payment_intent.canceled`
- `charge.refunded`
- `charge.dispute.created`

El preflight ahora también requiere `refund.created`, `refund.updated`, `refund.failed` y `charge.dispute.closed` antes de aprobar la cobertura. **No cambiar la configuración LIVE de Stripe todavía**: hacerlo junto con la entrega final, cuando el backend reciba, persista y procese dichos eventos. Aun con los eventos suscritos, la entrega de webhooks se valida mediante firmas reales y replay.

## 4. Bloqueos críticos abiertos (NO-GO)

1. **Producción Node completa**: `config.ts`, `server.ts` y `worker.ts` públicos fuerzan staging y no montan todo el checkout LIVE. Se requiere una migración del runtime preservando rutas comerciales, autenticación, soporte, admin, conductores y las apps existentes.
2. **Datos de producción**: provisionar PostgreSQL/Redis protegidos; migraciones y respaldo/restauración completos, validación de cuentas, restaurantes, pedidos, inventario y saldos. El entorno staging no puede convertirse implícitamente en tesorería real.
3. **Reembolsos/chargebacks**: ya se contabilizan con idempotencia los reembolsos confirmados, pero NO existe aún compensación financiera integral de cuentas a pagar a comercios, restauración de inventario, gestión de disputas ni reversos de entregas iniciadas. Los eventos no conciliables siguen en HOLD. No confundir débito de Stripe cobrado con reversión completa de la operación.
4. **Webhook/worker**: eventos firmados, duplicados, reordenados, caída de Stripe/DB, reintentos durables, alertas operativas, refund/chargeback; no basta HTTP 200.
5. **Stripe Connect**: completar alta de la cuenta receptora antes de transferir o liquidar. Mantener transfers/payouts deshabilitados hasta cierre independiente.
6. **Activación**: instalación privada de credenciales LIVE, permisos mínimos, comprobación de API, prueba controlada autorizada con dinero real + reembolso, reconciliación y rollback. Nunca automatizar cargos a clientes al instalar claves.

**Política financiera comercial:** preservar reglas acordadas de comisión de comercio (15% productos), tarifa de servicio (7% cliente), propinas sin comisión, envío según la lógica vigente y efectivo como alternativa. El backend debe calcular todos los importes; nunca confiar en totales provenientes del móvil.

## 5. Secuencia para el despliegue final en Kali (NO ejecutada)

1. Terminar e integrar todas las rutas y workers financieros en una única release candidata. Todas las suites CI y validaciones end-to-end deben pasar para el SHA exacto.
2. Backups con prueba de restauración y `migrations status` sobre base de producción; proteger datos de usuarios existentes. Verificar compatibilidad con AAB/APK de cada rol.
3. Configurar credenciales LIVE exclusivamente en `/home/tala-node-stage/.config/talaeats-node-live.env` (0600). Prohibido `cat`/eco en chat, logs o GitHub.
4. Confirmar claves de cuenta correcta, suscripciones de webhook, firma, idempotencia, compensaciones y monitorización.
5. Ejecutar **una** transacción LIVE de importe mínimo que el operador autorice explícitamente y comprobar pedido, webhook, ledger y reembolso. No crear una transacción sin su autorización específica.
6. Promover a la instancia pública PM2 actual conservando nombre de procesos, hostname y puerto. Mantener release anterior + rollback verificado; observar errores y fijar aceptación comercial por separado.

## 6. Evidencia y límites

- El operador confirmó en Kali que la API actual responde con `financialWrites=false` y `productionReady=false`; el instalador de secretos no modifica ese estado.
- Una revisión previa de la rama superó 3/3 suites CI (Stripe staging, ADMIN MFA y compras sintéticas). **La verificación de la última punta del PR debe realizarse de nuevo** antes del merge/despliegue.
- Nunca afirmar `LIVE_ACTIVATED` por el hecho de guardar `rk_live_`/`sk_live_` o superar pruebas sintéticas.

**Criterio de salida:** API pública lista para recibir órdenes y Stripe LIVE con transacciones confirmadas/compensadas, sin pérdida de inventario ni eventos, sin exposición de secretos y con rollback probado. Si falla cualquier requisito, se mantiene el checkout LIVE bloqueado.
