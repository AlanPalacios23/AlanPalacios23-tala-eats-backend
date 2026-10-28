# RC9 Treasury — Restaurantes y Repartidores (Node.js)
**Candidato de desarrollo, 28-oct-2026. NO LIVE, NO deploy, NO transferencias habilitadas.**

## Qué se implementó realmente
- Se conserva la infraestructura LIVE Node RC8, no se revive FastAPI/Python.
- `src/live/merchant-finance-router.ts`: `GET /owner/finance/connect/:id/status` ahora retorna `restaurant_id` y `ready`, con verificación Stripe MX, email del dueño activo, aprobación, capacidades y requisitos sin pendientes. Corrige la incompatibilidad con la app Restaurantes Web; no implica autorización de retiro.
- `src/live/treasury-policy.ts`: cálculo exacto en centavos del mínimo entre transferencia Connect **completada y verificada**, menos retiros confirmados/reservados, y saldo real de Stripe Connect; casos de reembolso, transferencias no conciliadas, payouts externos, KYC y cuenta bancaria bloquean saldo retirable.
- `src/live/treasury-router.ts`: `GET /api/v1/withdrawals/restaurant/:id/balance`, `GET /api/v1/withdrawals/driver/:id/balance` y los correspondientes `/history`. Exige sesión/rol, propiedad exclusiva del restaurante o identidad del conductor verificado. Contrasta account, cargo original, transferencias Stripe, montos reales, incidentes y saldo Stripe. No expone cuentas bancarias completas ni claves. La cuenta bancaria se valida en modo **solo lectura** mediante `treasury-bank-verification.ts`, incluyendo histórico paginado de payouts conocidos y coincidencia de beneficiario, id de solicitud, estado, importe y destino. Si faltan pruebas devuelve HOLD/503; `server_allows_requests=false` en esta release aunque exista saldo verificado.
- `POST /api/v1/withdrawals/:role/:id/request` entrega **503 no liberado**. Se deja la ruta reservada, NO transferencias reales. La aplicación no debe habilitar retiros con esa respuesta.
- `src/live/treasury-execution.ts`: adaptadores **no montados** de Stripe Transfer/Payout, separados, ligados a transacción original, metadatos, idempotencyKey, reserva durable y revisión por dos usuarios diferentes. Retorno Stripe `submitted`, nunca `paid` sin webhook. Un kill switch en producción bloquea las dos operaciones **incluso si se les pasa releaseApproved=true**. Solo se ejercitan con mocks sin red.
- `src/live/treasury-webhook-policy.ts`: validador de estado de payout para integración futura con **webhook Connect firmado dedicado**, identidad de beneficiario, cuenta, banco, moneda, centavos, objeto y metadatos contra retiro persistido. No marca eventos terminales conflictivos como pagados; los retiene para revisión. **Aún no es un receptor HTTP firmado ni un reconciliador DB.**
- Migración y modelos Prisma: `tala_live_treasury_transfers`, `tala_live_treasury_withdrawals`, `tala_live_treasury_events`; identidad dual (restaurant/driver), idempotencia única por beneficiario/pedido, OTP de un solo uso, límites por estado y único retiro en vuelo.
- Pruebas `rc9-treasury-*.test.mjs` de centavos, KYC, retiros dobles, categorías, eventos fuera de orden, rechazo de producción, simulación de Stripe sin dinero. CI Node 24 + Prisma y migración PG15 aislada.

## Modelo de dinero que NO se debe confundir
1. Cliente paga a plataforma. Recibo firmado + ledger = pago contabilizado, NO saldo de comercio.
2. Entrega confirmada + prueba + sin refund/disputa = posible derecho contable, NO transferencia ejecutada.
3. `stripe.transfers.create` bajo aprobación y charge original = Stripe balance del destinatario. Aún **no liberado** en HTTP/worker.
4. Saldo disponible de la cuenta conectada y banco verificado, payout schedule manual y sin pagos externos = **posible saldo retirable**, sujeto a auditoría.
5. `stripe.payouts.create` usando cuenta Connect = solicitud al banco, NO depósito verificado.
6. Webhook Connect `payout.paid` autenticado + `payouts.retrieve` reconciliado = confirmación de pago; fallos/cancelaciones y reversos requieren ledger y conciliación.

## Pendiente ANTES de que cualquier restaurante o repartidor retire dinero
1. **Transferencias LIVE**: implementar controlador administrativo con doble aprobación MFA, bloqueo por pedido, reserva transaccional, saldo y charge original revisados, ejecución idempotente de `transfers.create`, registro de estado `unknown` en timeout y worker de conciliación. Test de dos aprobaciones simultáneas y reversos.
2. **Cuenta bancaria de Connect**: la auditoría de destino y payouts históricos de solo lectura ya está implementada; aún faltan pruebas de integración Stripe TEST y validación del comportamiento de bancos mexicanos, además de establecer una política operativa de destino aprobado antes de permitir escribir payouts.
3. **Solicitudes de retiro**: integrar paso adicional TOTP y contador global compartido (el backend Node ya tiene `verifyTotp`), límites por día, bloqueo PostgreSQL de beneficiario, reserva antes de Stripe y recuperación ante timeout sin doble pago. No reusar idempotencyKey para una solicitud diferente.
4. **Webhook Connect**: receptor HTTP crudo, secreto Connect independiente, verificación HMAC y account/mode, inbox duradero y conciliación con `payouts.retrieve`, estado auditado con ledger y cobertura de eventos fuera de orden, fallidos o desconocidos.
5. **Frontend**: Wallet restaurante y app Repartidor solo habilitar CTA si `server_allows_requests=true` del backend y saldo verificado; 2FA y confirmación irreversible, historial y estados inciertos. La app actual mantiene el botón informativo/bloqueado.
6. **GO/NO-GO**: pruebas Stripe TEST con Connect Express de ambas identidades, destino bancario de pruebas, integración de webhook sin fuga de claves y corrida real de PostgreSQL/Redis efímeros. Luego lectura PM2/proxy/BD LIVE y backup restaurable, revisión humana de doble aprobación y una nueva release específica para quitar el kill switch. No activar con solo un cambio de .env.

## Pruebas y compatibilidad
- No se cambian los cinco flags financieros existentes, el worker PM2, Redis, Cloudflare ni el dominio.
- Config de Node sigue rechazando `STRIPE_CONNECT_TRANSFERS_ENABLED=true` en producción.
- `NODE_TREASURY_LIVE_EXECUTION_ENABLED=false` es un segundo bloqueo independiente.
- PostgreSQL migración es **aditiva**, pero no se debe aplicar a LIVE antes de verificar el esquema real, backup y orden de migraciones.
- Rama: `feat/node-treasury-restaurant-driver-20261028` basada en PR #161. NO fusionar prematuramente ni usar `main` Python como base.

Este candidato es **fundamento seguro y verificable del sistema de retiros**, no la autorización final para mover dinero real.
