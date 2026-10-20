# Tala Eats · Gate P0 antes del primer despliegue Node.js en Kali

**Release candidata:** rama `feat/node-kali-direct-pm2-release-20261020`.
**Objetivo:** Node24 + PM2 en el staging nativo Kali, SIN reemplazar Python, Docker, DNS ni Stripe LIVE.

> IMPORTANTE: desde GitHub se puede revisar y probar código, pero **no se ejecutaron comandos en Kali**. El operador debe comprobar localmente la salida de cada etapa, con usuario `tala-node-stage`, sin colocar secretos en el chat. Si falla cualquier gate: NO-GO y no reiniciar procesos.

## Gate 0 · CI y migraciones en GitHub (sin Kali)

En la rama candidata, exigir checks **push y pull_request** PASS para el mismo SHA completo: compilación, PostgreSQL15/Redis8 efímeros, tests unitarios y E2E, inventario de rutas 249 activas + 3 MP retiradas, tarifa v1.6.2 cap $25, pruebas de seguridad del stage.

```bash
python3 node-backend/scripts/kali-stage-migration-static-audit.py --check
```

La auditoría estática analiza toda la historia Prisma. **No certifica compatibilidad con datos de Kali**: sí impide accidentalmente introducir SQL destructivo sin revisión.

## Gate 1 · Kali solo lectura

Desde una sesión Kali real, ya configurada, cambiar al usuario aislado `tala-node-stage` y ejecutar:

```bash
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
git clone --single-branch --branch feat/node-kali-direct-pm2-release-20261020 \
  https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend.git \
  "$HOME/tala-node-first-release-check"
cd "$HOME/tala-node-first-release-check"
git rev-parse HEAD
bash node-backend/scripts/kali-stage-first-release-preflight.sh --plan
python3 node-backend/scripts/kali-stage-migration-static-audit.py --check
bash node-backend/scripts/kali-stage-j1-predeploy-audit.sh --plan
```

**No-Go** si hay PM2 distinto de `tala-node-stage-api` y `tala-node-stage-worker`, puertos no loopback, `/ready` fallando, entorno inseguro, menos de 1GiB libre, o servicios ocultos usando la misma DB. El preflight es estricto, no crea nada.

## Gate 2 · Copia + restauración real SOLO PostgreSQL15 stage

Desde la raíz del clon y como usuario de staging:

```bash
python3 node-backend/scripts/kali-stage-backup.py --plan
TALA_STAGE_BACKUP_APPROVAL=I_APPROVE_STAGE_DB_BACKUP_ONLY \
  python3 node-backend/scripts/kali-stage-backup.py --apply

python3 node-backend/scripts/kali-stage-test-restore.py --plan
TALA_STAGE_RESTORE_APPROVAL=I_APPROVE_ISOLATED_STAGING_RESTORE_TEST \
  python3 node-backend/scripts/kali-stage-test-restore.py --apply
```

Exigir `PG15_STAGE_BACKUP_ARCHIVE=PASS`, `PG15_STAGE_ARCHIVE_LIST=PASS`, `SCRATCH_FULL_RESTORE=PASS`, `SCRATCH_CONTAINERLESS_CLEANUP=PASS`. Esta restauración usa una instancia Postgres **temporal sin TCP** y no reemplaza la base existente.

Si hay archivos multimedia de staging, respaldarlos por separado en un directorio privado y comprobar su restauración antes de migrar. **No respaldar ni borrar Docker de producción desde estos comandos.**

## Gate 3 · Construcción del SHA y revisión SQL en Kali

```bash
cd "$HOME/tala-node-first-release-check/node-backend"
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
npm ci --no-audit --no-fund
STAGE_ENV="$HOME/.config/talaeats-node-staging.env"
node --env-file="$STAGE_ENV" ./node_modules/prisma/build/index.js generate
node --env-file="$STAGE_ENV" ./node_modules/prisma/build/index.js validate
npm run build
npm test
node --env-file="$STAGE_ENV" ./node_modules/prisma/build/index.js migrate status
bash scripts/kali-stage-migrate.sh --preflight
```

**Revisar la salida de `migrate status` y los SQL pendientes**. Hay 21 migraciones en esta historia; no asumir que 21 están pendientes o que ya se aplicaron. Si un checksum o historial es distinto, detenerse. No usar `db push`, `migrate reset` ni apuntar a PostgreSQL productivo.

**Solo tras backup/restore PASS y aprobación separada de ese conjunto de SQL**, aplicar exclusivamente en PG15 stage:

```bash
TALA_STAGE_MIGRATE_APPROVAL=I_APPROVE_NEW_STAGE_SCHEMA_ONLY \
  bash scripts/kali-stage-migrate.sh --apply
node --env-file="$STAGE_ENV" ./node_modules/prisma/build/index.js migrate status
```

Cualquier error de migración es NO-GO; no iniciar PM2 nuevo.

## Gate 4 · Primer cambio controlado de PM2 staging

**Nuevo script de primera promoción**: `scripts/kali-stage-first-pm2-promote.sh`, distinto del actualizador rápido. La ejecución `--plan` es solo lectura y verifica versión exacta y rollback. La ejecución `--apply` requiere permisos explícitos; compila candidato en directorio aislado, respalda PostgreSQL15 staging, realiza restore en cluster efímero, respalda media staging si existe, verifica migraciones Prisma ya aplicadas, sustituye solo API/worker PM2 y hace smoke con SHA; ante fallo intenta rollback a la instancia PM2 anterior. No ejecuta migraciones ni toca Docker/Stripe LIVE.

Desde la carpeta de la nueva versión `node-backend` (ya clonada, en el usuario staging):

```bash
SHA="$(git rev-parse HEAD)"
bash scripts/kali-stage-first-pm2-promote.sh --plan "$SHA"
```

**Antes de aplicar**: ejecutar Gate 2 + Gate 3 y confirmar salida. El script `--apply` vuelve a crear/restaurar una copia antes de cambiar PM2, y aborta sin reiniciar si Prisma tiene alguna migración pendiente. Para ese caso, aplicar las migraciones solo mediante el Gate 3 por separado, después repetir `--apply`. El comando de cambio es:

```bash
TALA_STAGE_FIRST_PROMOTE_APPROVAL=I_APPROVE_FIRST_NODE_STAGE_PM2_ONLY \
TALA_STAGE_BACKUP_APPROVAL=I_APPROVE_STAGE_DB_BACKUP_ONLY \
TALA_STAGE_RESTORE_APPROVAL=I_APPROVE_ISOLATED_STAGING_RESTORE_TEST \
  bash scripts/kali-stage-first-pm2-promote.sh --apply "$SHA"
```

**No lanzar este comando hasta haber revisado el resultado de preflight, backup/restore y migraciones con el operador.** No certificar el despliegue únicamente porque se haya ejecutado la instrucción: se exige la salida `FIRST_NODE_PM2_STAGE_PROMOTION=PASS` y el smoke estricto del SHA.


Para el primer salto desde la versión Node inicial, **NO usar `actualizar.sh --apply`**, pues está diseñado para actualizaciones sin migraciones. La nueva versión compilada debe quedar bajo directorio de release versionado, preservando intacta la anterior y documentando la ruta del PM2 activo.

Tras revisar el directorio ejecutable, el SHA exacto, migraciones aplicadas y plan de vuelta atrás, detener **solamente** los procesos PM2 `tala-node-stage-api` y `tala-node-stage-worker` y arrancarlos desde el `ecosystem.config.cjs` compilado; comprobar `/ready` ANTES de iniciar worker. No reiniciar `systemd` global, no usar `pm2 startup` ni mover el proxy público.

Verificar el SHA real con este script, pasando el SHA de 40 dígitos del candidato:

```bash
bash scripts/kali-stage-postdeploy-smoke.sh <SHA_COMPLETO_CONFIRMADO_EN_CI>
```

Si falla, restaurar **solo los procesos PM2 anteriores** desde su directorio intacto y volver a ejecutar `/ready`. No asumir que rollback de código revierte automáticamente migraciones o cambios de datos.

## Gate 5 · Contratos reales de aplicaciones y lanzamiento

Verificar con cuentas de **prueba stage**: Usuarios, Restaurante/Tienda, Repartidor y ADMIN; RBAC, catálogo, stock, precio, cash/pickup, estados KDS, cancelación, GPS/dispatch, medios privados y auditoría. Los pagos Stripe TEST deben tener pruebas de firma y eventos repetidos, conciliación y reversos antes de activar cobros. Endpoint 503 intencional es NO-GO para una función comercial prometida.

**Node staging PASS no significa producción PASS.** No cambiar Cloudflared, DNS, Caddy ni Stripe LIVE sin una fase de cutover aprobada y un rollback probado sobre los mismos datos.

## Actualizaciones posteriores

Una vez completado el primer despliegue con una rama de trabajo limpia, sin Prisma pendiente y con PM2+worker de stage en línea:

```bash
bash node-backend/scripts/actualizar.sh --plan
TALA_STAGE_UPDATE_APPROVAL=I_APPROVE_STAGE_PM2_CODE_ONLY \
  bash node-backend/scripts/actualizar.sh --apply
```

Este último script puede reiniciar PM2 **solo del staging** y rechaza diferencias del esquema Prisma. Nunca ejecuta migraciones de forma automática.

## Registro de evidencias y decisión

Para concluir registrar:
- SHA objetivo y SHA activo anterior en PM2;
- resultado CI y auditoría migraciones;
- backup `pg_dump -Fc` y **restore completo** de prueba; respaldo de multimedia;
- migraciones aplicadas/pendientes; `ready=true` y worker online;
- SHA del proceso real bajo PM2 y smoke estricto PASS;
- resultado de pruebas Android/iOS + ADMIN y rollback ensayado.

Sin estas evidencias, marcar `NO-GO KALI STAGE`; sin paridad y pagos test, marcar `NO-GO PRODUCCIÓN`.
