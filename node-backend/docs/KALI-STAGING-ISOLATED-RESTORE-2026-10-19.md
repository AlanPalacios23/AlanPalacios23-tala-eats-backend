# TALA EATS — Restauración completa de PostgreSQL 15 staging en cluster efímero

**Objetivo:** verificar en el Kali real que el archivo `pre-user-systemd-*.dump` permite restaurar de verdad la estructura y migraciones de la base nueva. Esta operación NO es una restauración de la base productiva ni modifica la base staging actual.

## Evidencia disponible

19-oct-2026, el operador ya confirmó `pg_dump -Fc`, `pg_restore --list`, permiso 0600 y traspaso de tres servicios `systemd --user` bajo `tala-node-stage`; API y worker PM2 online y `/ready` true.

La prueba de restauración pendiente tiene control exclusivo sobre un directorio temporal dentro del HOME del usuario. Invoca únicamente el PostgreSQL nativo 15.19 compilado bajo HOME staging y arranca una instancia temporal **sin TCP** (`listen_addresses = ''`), socket privado 0700 y conexión local `15436` identificada por ruta de socket, no por puerto de producción. No necesita superusuario ni modifica el Postgres 18/main u otros clusters.

## Procedimiento

Con el usuario `tala-node-stage`:

```bash
cd "$HOME/talaeats-node-source"
git fetch origin feat/node24-pm2-native-staging-20261019
git checkout --detach <CI_VERIFIED_SHA>

python3 node-backend/scripts/kali-stage-test-restore.py --plan

TALA_STAGE_RESTORE_APPROVAL=I_APPROVE_ISOLATED_STAGING_RESTORE_TEST \
  python3 node-backend/scripts/kali-stage-test-restore.py --apply
```

Criterios de éxito:

- `STAGING_BACKUP_ARCHIVE_VALID=PASS`.
- `STAGING_SOURCE_READY=PASS`.
- `SCRATCH_SOCKET_ONLY_POSTGRES_READY=PASS`.
- `SCRATCH_SCHEMA_AND_MIGRATION=PASS`.
- `SCRATCH_FULL_RESTORE=PASS`.
- `SCRATCH_CONTAINERLESS_CLEANUP=PASS`.

El proceso restaura todas las entradas del archivo en una DB temporal con `pg_restore --no-owner --no-acl --exit-on-error --single-transaction`. Comprueba las tablas `stripe_webhook_events`, `merchant_connect_accounts`, `payout_instructions` y que Prisma registró la migración `20261019_initial`. Luego detiene el proceso temporal y elimina exclusivamente la carpeta scratch si ya no queda un `postmaster.pid`.

**Si falla:** no volver a ejecutar el proceso automáticamente; revisar salida. Si se presenta `SCRATCH_NOT_REMOVED_SERVER_MAY_BE_RUNNING`, queda un cluster scratch detenido o activo en un directorio privado que debe inspeccionarse antes de limpiar. No usar `rm -rf` manual a ciegas ni ejecutar `pg_ctlcluster` de Debian/Kali.

Los scripts no cargan ni imprimen las contraseñas staging y no aceptan `DATABASE_URL` externa para la instancia de restauración. El informe real queda pendiente hasta ejecutar este comando en Kali.

## Posterior: GitHub → Node/PM2 staging

La sincronización continua debe salir exclusivamente de CI verde para un SHA exacto, descargar un artefacto/release firmado o validado en una ruta independiente, ejecutar `npm ci`, compilación/test y revisión de migraciones sin aplicar automáticamente schema; luego promover solamente API y worker staging con `/ready` antes de cerrar el gate. Mantener release anterior para rollback.

**No se han configurado secretos SSH ni activado un agente de despliegue en producción.** La PR #79 estaba hecha para Python/FastAPI y no debe fusionarse para este proyecto Node.
