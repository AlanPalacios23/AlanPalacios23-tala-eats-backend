# TALA EATS RC13.5 — Runbook de despliegue candidato a Kali
Estado: NO desplegado, NO modifica LIVE, para revisión de producción. Piloto objetivo 08/11/2026.

## Release fijada
- Backend PR #201 rama release/rc135-finance-pilot-candidate-20261029, congelar SHA verificado antes de compilar.
- PWA PR #18 rama release/rc135-pwa-pilot-candidate-20261029, congelar SHA verificado para tres bundles.
- Predecesor históricamente verificado RC12.8: 1562827129b90094bce90cca3647c57d94e33fcc. Leer PM2 en vivo; no asumir sigue instalado.
- LIVE Node/API+worker port 18190. Clientes 18195, restaurante 18197, conductor 18199. Los tres portales ya tienen nginx y systemd independientes.

## GO A: GitHub CI en SHA final
- [ ] Backend npm ci, TS build, migrate PG15, tests, worker E2E, journal RC13.3 inmutable y doble recibo cash RC13.5 PASS.
- [ ] PWA build y QA visual 320/360/390/430 dp de Usuarios, Restaurante y Repartidores PASS.
- [ ] API REST comprobada sin exposición de saldos: owner Wallet solo dueño; driver Wallet solo su usuario; ADMIN restore requiere rol+2FA.
- [ ] Verificar flags financieros con sus valores actuales REALES. Nuevas funciones OFF: LIVE_CASH_HANDOFF_V2_ENABLED=false, VITE_CASH_HANDOFF_V2_ENABLED=false, VITE_FINANCE_WALLET_V2_ENABLED=false.
- [ ] Ninguna persona aprueba Stripe card delivery, cash delivery, Connect transfers o retiros por la mera existencia de este PR.

## GO B: Kali staging PARALELO completamente aislado
1. Descarga por SHA en release staging nueva (NO dentro del release LIVE). Puerto API distinto a 18190, DB Postgres distinta, Redis distinto y exclusivamente claves Stripe TEST.
2. Prohibido usar api-stage-talaeats.* sin confirmar destino: el alias había apuntado a LIVE. Verificar con curl y proceso antes de enviar cualquier solicitud.
3. En node-backend candidato staging: npm ci --no-audit --no-fund, npm run generate, npm run db:validate, npm run db:migrate:deploy, npm run build, npm test. Registrar resultado íntegro y esquema migrado.
4. Comprobar tablas finance_accounts_v2, finance_journals_v2, finance_postings_v2, finance_cash_handoffs_v2 y finance_cash_handoff_events_v2, balance DB, inmutabilidad, replay, idempotencia.
5. Ensayo con 3 PWA, roles reales de stage: cliente compra, restaurante confirma/prepara/READY, driver recoge/entrega PIN, cash full handoff con dos usuarios y código, Stripe TEST firmado, fallos de red, timeout, reintentos, devolución y disputa.
6. Caja: driver no retiene sus $32 del efectivo; queda en tránsito hasta acuse del comercio. Acuse NO es transferencia bancaria, no emite CFDI ni habilita payout.
7. Probar autorización cruzada entre dos comercios y dos drivers, acceso ajeno denegado, códigos incorrectos, expirados o reusados; rollback íntegro de API/worker/PWA.

## GO C: promoción LIVE controlada — NO ejecutar sin aprobación
1. Respaldar PostgreSQL y probar restauración en entorno aislado; snapshots de PM2/nginx/systemd y env (sin imprimir secretos), Redis/outbox, estructura anterior y SHAs.
2. Verificar cero migraciones desconocidas, ninguna colisión de esquema y los últimos pedidos financieros conciliados. Bloquear rollout ante diferencias.
3. Instalar release nueva por SHA; aplicar migraciones aditivas bajo ventana aprobada, sin DROP/TRUNCATE ni borrado de historial; PM2 API y worker mismo SHA y rollback previo preservado.
4. GET health/ready y logs; backend ADMIN restore de comercio suspendido/auditoría/2FA; comprobación de un producto realmente disponible; estado de recepción y negocio cerrado al restaurarlo.
5. Publicar tres PWA desde builds por SHA, conservando flags VITE nuevas false. Revisar login, navegador móvil, SW, manifest, checkout existente y rutas privadas.
6. Si autorización/contabilidad/stock/webhooks fallan, NO activar cobros. Habilitar vista Wallet sólo si la consulta servidor y RBAC están comprobados; seguir sin retiros.
7. Activar cada modo de pago (pickup cash/card, delivery cash/card) en decisiones GO independientes, con pago real supervisado autorizado por comprador, reversión y conciliación. Nunca activar delivery cash antes de alinear legacy custody con handoff nuevo y liquidación.

## Rollback y dinero en tránsito
- Deshabilitar admisión de nuevos pedidos del modo afectado; NO cancelar ni borrar los pedidos ya capturados. Conservar listener y reconciliación Stripe firmada y entrega que está en curso.
- Retroceder simultáneamente API+worker y los tres frontends a SHAs anteriores. No destruir tablas ni diarios nuevos. Reconciliar eventos de la ventana de corte y efectivo que esté con driver.
- Registrar incidente, IDs sin PII, saldos/estados, hora local, accion autorizada, plan de recuperación, pruebas PASS/NO-GO.

## BLOQUEOS funcionales que no se deben ocultar
- Libro general RC13.3 aún no tiene adaptadores LIVE definitivos para todos los pagos, facturas y transferencias; una tabla no equivale a un movimiento bancario.
- Wallet semanal RC13.4 es lectura de asignaciones existentes y no un estado bancario definitivo; cierre semanal conciliado, compensación contractual y pagos automatizados pendientes.
- Handoff cash RC13.5 necesita ensayos reales de dos identidades y alineación con cash custody legado para evitar doble deuda; no activar hasta pruebas.
- Emisión CFDI SAT/PAC, impuestos, retenciones y recibos laborales siguen pendientes de definiciones fiscales/legales y timbrado real.
- Retiros a bancos mediante Connect permanecen deshabilitados hasta KYC, fondos disponibles, reconciliación, TOTP y doble aprobación verificada.

Este documento es una puerta de control de release, NO una afirmación de despliegue exitoso.