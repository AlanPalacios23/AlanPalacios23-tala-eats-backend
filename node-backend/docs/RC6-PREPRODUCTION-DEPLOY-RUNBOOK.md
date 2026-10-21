# TALA EATS Node.js — RC6 PREPRODUCCIÓN / PLAN DE DESPLIEGUE

**Fecha:** 21 de octubre de 2026  
**Estado:** candidato de **staging**. NO autorizar aún tráfico comercial ni sustituir Python.  
**Base:** RC5 validado (commit `814287552501f8f1a8d5a0ef6dff6b43cefa3bd1`)  
**Rama candidata:** `release/node-production-readiness-safety-20261021`  
**Objetivo:** preparar un release instalable y reversible para el Kali de pruebas sin dinero real.

## Qué significa pasar de RC5 a RC6

- **Aprobación de repartidores a prueba de omisiones**: `driver_profiles.is_verified` pasa de DEFAULT TRUE a DEFAULT FALSE tanto en Prisma como en PostgreSQL. Un `INSERT` SQL sin especificar el campo debe quedar **no verificado**.
- La migración **no altera ni revoca cuentas actuales**: solo cambia el DEFAULT de futuras filas. Antes de producción, auditar todos los repartidores previamente verificados y comprobar sus documentos. No aprobar automáticamente perfiles históricos.
- CI PG15/Redis8: prueba directa de `INSERT INTO driver_profiles(user_id)` con el nuevo DEFAULT, además de E2E de aprobación del conductor y pedidos sintéticos.
- **Rollback con observabilidad**: el smoke posterior a la promoción PM2 exige heartbeat real del worker, aislamiento de catálogo por localidad, Stripe desactivado y dependencias sanas. Se espera de manera acotada la primera señal del worker y se falla si no llega.
- Se ejecutan nuevamente las **500 compras simuladas** y las carreras de stock/cancelación cuando cambien Prisma o el circuito de pedidos.

## Cómo preparar el despliegue a Kali staging (sin hacerlo todavía)

1. Confirmar **SUCCESS** en los checks PG15 Redis8, ADMIN, 500 compras, carreras de inventario y release gates para el **SHA exacto** del PR. Guardar las URLs de evidencia y revisar el SQL.
2. Revisar la migración incremental en `prisma/migrations/20261021_driver_verification_fail_closed/migration.sql`. Solo permite `ALTER TABLE "driver_profiles" ALTER COLUMN "is_verified" SET DEFAULT FALSE;` en PG15 de staging.
3. Como usuario `tala-node-stage` del servidor Kali, confirmar `HOME=/home/tala-node-stage`, Node 24, PostgreSQL 15 exclusivo `127.0.0.1:15435/tala_node_stage`, Redis 8 `127.0.0.1:16379/0`, PM2 limitado a `tala-node-stage-api` y `tala-node-stage-worker`. No mostrar secretos del archivo `.env`.
4. Obtener un *worktree* limpio apuntando al SHA revisado dentro de `/home/tala-node-stage/tala-node-releases/<SHA>`. Construir ahí con `npm ci`, `npm run generate`, `npm run db:validate`, `npm run build`, `npm test`; verificar `node scripts/release-readiness.mjs --stage`. No tocar el directorio PM2 activo.
5. Inspección estática: `python3 scripts/kali-stage-migration-static-audit.py --check`. Preflight de aislamiento: `bash scripts/kali-stage-migrate.sh --preflight`. Ambos deben dar PASS.
6. **Antes de cualquier cambio en base de datos**: respaldo privado con `kali-stage-backup.py --apply`, su integridad y simulación de restauración en instancia PG15 socket-only con `kali-stage-test-restore.py --apply`. Guardar además media privada (incluido legado en `/tmp` si existiera). Estos comandos requieren sus aprobaciones explícitas; NO ejecutarlos en producción Python.
7. Aplicar la migración **solo** a PostgreSQL 15 staging con `kali-stage-migrate.sh --apply` y su aprobación explícita de esquema. Revisar con `prisma migrate status`; si falla, **STOP**.
8. Evaluar primero `kali-stage-first-pm2-promote.sh --plan <FULL_SHA>`. Solo tras revisión humana y las tres aprobaciones de staging: `--apply <FULL_SHA>`; supervisa PM2, hace backup/restore y rollback de procesos ante fallo de health/smoke. **NO usar** `actualizar.sh --apply` para saltarse la compuerta de migraciones; ese actualizador bloqueará cambios Prisma deliberadamente.
9. Ejecutar `bash scripts/kali-stage-postdeploy-smoke.sh <FULL_SHA>` (GET, sin mutaciones). Confirmar HTTPS público del host **stage** desde un dispositivo y registrar `/health`, `/ready` y `workerOnline=true`.
10. Validación en teléfonos **Android/iOS de pruebas**, con cuentas sintéticas: Usuarios → pedido efectivo/recoger → KDS Restaurante → código PIN → finalización → notificación; cancelación, stock, menús e imágenes; usuarios sin documentos verificados no aparecen en el catálogo ni aceptan pedidos; repartidores nuevos **no pueden conectarse sin aprobación**. Abrir ticket de Usuarios y responder desde ADMIN con TOTP.

## Bloqueos innegociables para pasar el tráfico real de Python a Node

| Puerta | Situación actual | Evidencia exigida |
|---|---|---|
| API y BD en Kali stage | No demostrada por CI | PG/Redis worker, smoke HTTP y rollback probados |
| Operaciones reales de entrega | Solo fixtures de Repartidor sintéticos | E2E real GPS/dispatch/KDS/driver/PIN sin filas sintéticas |
| Stripe | Escrito y conciliación LIVE deshabilitados | Ciclo completo Stripe TEST: PaymentIntent, webhooks, deduplicación, ledger, reembolso, conciliación, liquidación; revisión separada del cambio LIVE |
| Identidad y recuperación | Mail depende de proveedor verificado | Recuperación enviada/consumida en app, verificación de enlaces y MFA ADMIN real |
| Datos | Esquema staging aditivo; no hay migración Python→Node aprobada | Diseño y restauración probada de datos reales, sin perder saldos, historiales ni derechos de privacidad |
| Lanzamiento | Falta prueba de carga en host real y monitoreo | Carga gradual con usuarios/tiendas de QA, métricas CPU/RAM/DB, presupuesto de errores y rollback de tráfico |

**NO-GO automático:** `productionReady=false`, `financialWrites=false`, `STRIPE_FINANCIAL_WRITES_ENABLED=false`. Estos valores son intencionales y no deben anularse editando banderas a mano.

## Resultado previsto

Cuando todas las pruebas y migraciones de staging den PASS, RC6 se podrá **desplegar a Kali de pruebas con rollback**; el backend Python continúa sirviendo a clientes comerciales. Solo después se diseña e implementa la transición separada de datos, pagos y tráfico productivo con su propia autorización.
