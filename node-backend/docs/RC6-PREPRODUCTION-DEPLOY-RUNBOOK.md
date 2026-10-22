# TALA EATS Node.js — RC6 PREPRODUCCIÓN / PLAN DE DESPLIEGUE

**Fecha del plan original:** 21 de octubre de 2026  
**Estado del documento:** **HISTÓRICO / PRE-DESPLIEGUE**. El operador completó posteriormente la promoción PM2, publicó RC6 por Cloudflare y retiró los seis contenedores Docker Python del proyecto Tala Eats. **El código Node sigue siendo staging y NO está aprobado comercialmente.**  
**Base histórica:** RC5 validado (commit `814287552501f8f1a8d5a0ef6dff6b43cefa3bd1`); RC6 integrado mediante PR #120 y #121  
**Rama de lanzamiento:** `feat/node-kali-direct-pm2-release-20261020` (no confundir con `main`, que aún contiene Python)  
**Objetivo:** preparar un release instalable y reversible para el Kali de pruebas sin dinero real.

> **ACTUALIZACIÓN OPERATIVA 21/22-OCT-2026 — LEER ANTES DE REUTILIZAR COMANDOS.** Este runbook fue redactado **antes** de que el operador ejecutara los pasos descritos. La fuente de verdad de la configuración **ahora vigente** (dominio público → Node RC6, SHA `30ab51b587b21127c3f3419e0ec4c3a8539dfb0a`, Docker Python retirado, respaldos y volúmenes preservados, límites funcionales) es [KALI-NODE-RC6-PUBLIC-API-AND-LEGACY-RETIREMENT-20261022.md](KALI-NODE-RC6-PUBLIC-API-AND-LEGACY-RETIREMENT-20261022.md). **NO** repetir migraciones, `--apply`, publicar Python otra vez ni confundir HEAD de GitHub con el SHA instalado.  
> Los pasos siguientes se conservan como **historia y referencia técnica**, no instrucciones de ejecución inmediata.

## RC6 revisado: plan SHA-fijado, sin efectos laterales

**La compuerta adicional de RC6** está en `scripts/rc6-schema-gate.mjs --check` y tiene su workflow específico `tala-node-rc6-kali-gates.yml`. Exige SQL idéntico al autorizado para las dos migraciones acumuladas, `driver_profiles.is_verified DEFAULT FALSE`, Stripe desactivado, y los scripts de copia/restauración/smoke en el circuito de promoción.

**No usar simplemente `actualizar.sh --apply`** desde un RC anterior: detectará cambios Prisma y abortará. No eliminar esa comprobación.

### Obtener el SHA aprobado

Las dos compuertas **RC6 Kali staging release safety** y **500 Compras Ficticias PG15 Redis8** deben terminar con `success` también para el **commit de merge definitivo**, no solamente para el `head_sha` del PR. Estos workflows ahora admiten `push` a la rama de lanzamiento. Si GitHub aún no muestra ambas ejecuciones en el SHA definitivo, el lanzamiento queda bloqueado.

La promoción PM2 vuelve a ejecutar `rc6-schema-gate.mjs --check` y `release-readiness.mjs --stage` justo antes de preparar el release, y exige un worktree dentro de `~/tala-node-releases/<SHA>`. No ejecutar ninguna promoción desde un clone genérico ni omitir estas comprobaciones.

**Ejemplo para fijar el commit sin usar el nombre de la rama como release** (como `tala-node-stage`, desde un repositorio de staging ya clonado y auditado; adaptar la ubicación `SRC_REPO` a la instalación existente):

```bash
export SRC_REPO="$HOME/tala-node-src"
export RC6_BRANCH="feat/node-kali-direct-pm2-release-20261020"
test "$(id -un)" = "tala-node-stage"
git -C "$SRC_REPO" remote get-url origin | grep -Fx "https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend.git"
git -C "$SRC_REPO" fetch --no-tags origin "$RC6_BRANCH"
export RC6_SHA="$(git -C "$SRC_REPO" rev-parse --verify FETCH_HEAD)"
test "$(git -C "$SRC_REPO" ls-remote origin "refs/heads/$RC6_BRANCH" | awk '{print $1}')" = "$RC6_SHA"
test ! -e "$HOME/tala-node-releases/$RC6_SHA"
git -C "$SRC_REPO" worktree add --detach "$HOME/tala-node-releases/$RC6_SHA" "$RC6_SHA"
cd "$HOME/tala-node-releases/$RC6_SHA/node-backend"
npm ci --no-audit --no-fund
npm run generate && npm run db:validate && npm run build && npm test
node scripts/rc6-schema-gate.mjs --check
bash scripts/kali-rc6-release-plan.sh --plan "$RC6_SHA"
```

**Importante:** comprobar en GitHub las dos ejecuciones PASS de ese `RC6_SHA` **antes** del primer `git worktree add`; el bloque anterior no instala servicios ni modifica la BD, pero sí descarga dependencias y construye código. `--plan` es la única operación de publicación autorizada en este paso; backup, restauración, migración y PM2 `--apply` siguen siendo pasos separados y supervisados.

Solo cuando **todas** las ejecuciones de GitHub Actions estén verdes para la rama de release ya fusionada, inspeccionar el último commit en GitHub y fijarlo en el operador de Kali. El nombre de rama por sí solo NO garantiza qué código está instalado.

En Kali, como el usuario `tala-node-stage`, crear el worktree candidato mediante el flujo Git manual revisado; el destino debe ser estrictamente `/home/tala-node-stage/tala-node-releases/<SHA_COMPLETO>`. Con el worktree creado y las dependencias instaladas, ejecutar **solo lectura**:

```bash
cd "/home/tala-node-stage/tala-node-releases/<SHA_COMPLETO>/node-backend"
bash scripts/kali-rc6-release-plan.sh --plan "<SHA_COMPLETO>"
```

El plan confirma identidad del usuario, SHA fijo, árbol sin modificaciones, ruta segura, Node 24, archivo de entorno privado, PostgreSQL y Redis aislados, PM2 actual sano, puertos locales, requisitos SQL y código. **No instala, migra, cobra ni reinicia servicios.** Los cambios siguientes requieren autorización humana y se realizan en las etapas 5–9 de este documento.

Para repetir el control en cualquier máquina de desarrollo, sin acceder a Kali: `cd node-backend && node scripts/rc6-schema-gate.mjs --check`.

### Política de restauración
- **No es suficiente crear un archivo de backup.** Ejecutar y verificar restauración aislada PG15 antes de la migración real de staging.
- Preservar datos de documentos/fotos y respaldar media de `/home/tala-node-stage/media` y del legado en `/tmp/tala-node-stage-media` si aún existe, con los permisos del usuario de staging.
- No atribuir `PRODUCTION_READY` a un `ready=true`. **Nota histórica:** durante la planificación se prohibía apuntar el hostname a Node; posteriormente el operador **sí lo publicó expresamente** y retiró los contenedores Python. Eso no demuestra paridad, migración de datos ni autorización de pagos; consultar la bitácora operativa actual.
- La aprobación del equipo para operar comercialmente es independiente de las pruebas en GitHub y de la promoción PM2.

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

## Resultado y estado posterior (21/22-oct-2026)

**El despliegue PM2 de Node RC6 ya sucedió**, y el operador confirmó `FIRST_NODE_PM2_STAGE_PROMOTION=PASS` junto con `KALI_NODE_PM2_STAGE_POSTDEPLOY_SMOKE=PASS`. El túnel público fue cambiado a Node y los seis contenedores Docker Python `talaeats-v3` se retiraron. La infraestructura real actual, el inventario detallado y los respaldos están en la [bitácora operativa](KALI-NODE-RC6-PUBLIC-API-AND-LEGACY-RETIREMENT-20261022.md).

La decisión de exponer staging **no** eliminó los gates de producción comercial. `productionReady=false`, `financialWrites=false`, ausencia de migración de datos Python→Node acreditada y QA pendiente de las apps siguen siendo bloqueos. No se garantiza que los usuarios reales puedan operar; no habilitar Stripe LIVE.
