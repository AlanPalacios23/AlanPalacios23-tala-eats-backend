# TALA EATS RC8.13 — Consolidación de dos runtimes en UN solo LIVE

**Decisión solicitada**: reemplazar en Kali el código del backend público RC8.6
por RC8.13 manteniendo la identidad de PM2, el dominio, las cuentas reales,
la base de datos PostgreSQL LIVE y el Stripe LIVE actual.

**GitHub no da acceso SSH a Kali.** Este cambio requiere comandos ejecutados
en la terminal del servidor. La PR no es una afirmación de despliegue.

## Hechos confirmados

- LIVE actual (PM2 predeterminado) `127.0.0.1:18190`, versión
  `rc8.6-live-pickup-finance-review`, SHA
  `fbacabaae34e6dea8718aa6ced648431248dfbab`.
- STAGING de prueba temporal ya activo con SHA
  `85be7be4247a58d136d6756776384b69082ac57b`,
  PM2_HOME separado `~/.pm2-tala-rc813-parallel`, puerto local 18192,
  PostgreSQL stage 15 en 15435, Redis stage DB1.
- GitHub compare RC8.6→RC8.13: `ahead_by=163`, `behind_by=0`.
  El repositorio más nuevo YA incluye el código antiguo: **no importar
  cuentas ni dinero desde staging al LIVE**.
- Stripe Connect transferencias automáticas siguen desactivadas.
- Las rutas de delivery con repartidor de RC8.13 siguen protegidas por flags
  de staging; **no** promocionarlas a LIVE sin auditoría end-to-end de dinero
  real, reconciliación y pagos al repartidor.

## A. Desde la cuenta tala-node-stage: checkout SHA-pinned NUEVO

Consultar último SHA aprobado y CI en PR #159
`release/rc813-unified-live-20261024`; sustituir variable por ese SHA.

```bash
SHA="<SHA_FINAL_RC813_UNIFIED_LIVE_40_HEX>"
BRANCH="release/rc813-unified-live-20261024"
ROOT="$HOME/tala-node-releases/$SHA"
test "$(id -un)" = tala-node-stage
test ! -e "$ROOT"
git clone --depth 1 --branch "$BRANCH" \
  https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend.git "$ROOT"
test "$(git -C "$ROOT" rev-parse --verify HEAD)" = "$SHA"
cd "$ROOT/node-backend"
```

## B. Preparación y plan (sin sustitución PM2 ni migraciones)

```bash
bash scripts/rc813-unified-live-preflight.sh --prepare "$SHA"
bash scripts/rc813-unified-live-preflight.sh --plan "$SHA"
```

Requisitos del `--plan`:
- Config protegida `~/.config/talaeats-node-live.env` propiedad del usuario
  y `0600`, producción en loopback 18190, sin flags de staging;
- Stripe LIVE **ya** con las cinco banderas financieras aprobadas, sin
  modificar esas banderas; Connect transfers OFF;
- Dos PM2 viejos **realmente en producción**, ambos online y misma cwd;
- Prisma `migrate status` en la **base LIVE** sin migraciones pendientes;
- Lecturas de `inspectLiveFinancialData`, Stripe LIVE GET /account y
  GET /webhook_endpoints: contrato PASS;
- LIVE anterior disponible tanto local como públicamente.

Si falla `--plan`, detenerse. Nunca cambiar `NODE_ENV` de producción
a staging, apuntar LIVE a PG15 de pruebas, copiar claves a GitHub o forzar
las banderas financieras para superar el gate.

## C. Respaldo y restauración

El promotor `rc813-unified-live-cutover.sh` **crea un respaldo completo de
la base LIVE** mediante `pg_dump -Fc` y valida `pg_restore --list`, sin
imprimir URL ni contraseña. Genera configuración canónica de rollback con
rutas controladas y permisos privados en `~/tala-node-backups/`.

**Un archivo legible NO demuestra una restauración completa**. Antes de
tomar tráfico comercial real, hacer un ensayo independiente de restauración
sobre una instancia aislada compatible con la misma versión mayor de
PostgreSQL de LIVE. No apuntar al PG15 staging si la versión LIVE difiere.

## D. Conmutación LIVE (modifica SOLO los dos PM2 públicos)

Con ventana de mantenimiento aprobada; el endpoint 18190 puede dar errores
transitorios mientras se sustituyen los dos procesos. Si hay clientes o
webhooks en curso, coordinar reintentos, drenar y reconciliar eventos antes.

```bash
bash scripts/rc813-unified-live-cutover.sh "$SHA" \
  I_APPROVE_RC813_EXISTING_LIVE_PM2_CUTOVER
```

Internamente reejecuta el plan, guarda backup LIVE, crea plan de rollback,
detiene la vieja API antes del viejo worker, borra **solo el heartbeat Redis
LIVE**, inicia `dist/live/production-worker.js`, confirma nuevo heartbeat,
inicia la nueva API `dist/server.js`, exige `/health` nueva versión
`rc8.13-unified-live` y `/ready` con escrituras online autorizadas,
local y público, luego `pm2 save`. Si falla después del corte, intenta
restaurar los dos procesos anteriores. Revisar logs y estado del libro
contable antes de reabrir si hubo error.

**El promotor no ejecuta `prisma migrate deploy` ni modifica claves,
restricciones de cobro o destinatarios Connect.**

## E. Verificar LIVE después del despliegue

```bash
bash scripts/rc813-unified-live-preflight.sh --verify "$SHA"
```

Debe mostrar `RC813_UNIFIED_LIVE_LOCAL_AND_PUBLIC_READY=PASS`.
Además confirmar los dos PM2 públicos sobre el **mismo SHA nuevo** y
comprobar rutas legales `/privacidad` y `/eliminar-cuenta` (HTTP 200).

## F. Dejar UN SOLO backend ejecutándose (retirar staging temporal)

**Solamente tras asegurar LIVE**, ejecutar:

```bash
bash scripts/rc813-retire-parallel-stage.sh --plan "$SHA"
bash scripts/rc813-retire-parallel-stage.sh --apply "$SHA" \
  I_APPROVE_STOP_RC813_STAGING_PM2_ONLY
```

Apaga **solo** el PM2 separado de `18192` y revalida LIVE; conserva la
base de pruebas, el Redis DB1 y respaldos para auditoría o recuperación.
No toca Cloudflared ni las páginas legales.

### Estado de funcionalidades
- Producción: compatibilidad con checkout Stripe LIVE y sus controles de
  RC8.6, con código actualizado y una sola API pública de RC8.13.
- Entrega de repartidor en LIVE: **NO-GO** hasta pruebas dedicadas; no
  interpretar un E2E cash en staging como una autorización de pago real.
- Stripe Connect automatic payouts: **OFF**. Reembolsos/disputas y
  conciliación siguen condicionados por el ledger y sus gates existentes.
