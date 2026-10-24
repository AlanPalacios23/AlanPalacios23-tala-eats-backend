# TALA EATS | RC8.12 Kali staging: despliegue SHA exacto y pruebas

**Fecha:** 24 octubre 2026 · **Estado:** PREPARADO EN GITHUB, NO INSTALADO EN KALI desde este PR.

Origen RC8.12: PR #157 sobre RC8.11 PR #155. La conexión GitHub permite publicar
los scripts y validarlos en Actions, **no ejecutarlos en Kali**.

## Alcance explícito

- Actualizar únicamente `tala-node-stage-api` y `tala-node-stage-worker`
  del usuario `tala-node-stage`, API localhost `127.0.0.1:18190`.
- Usar base aislada `tala_node_stage` en `127.0.0.1:15435`,
  Redis `127.0.0.1:16379/0`, clave de staging privada de modo 0600.
- El promotor existente está protegido específicamente para **PostgreSQL 15**.
  Si el cluster actual es PostgreSQL 18, **HOLD**: no inventar identidad ni
  aplicar el migrador PG15 a PostgreSQL 18. Es necesario reconciliar y auditar
  un procedimiento PG18 independiente antes de cambiar cualquier proceso.
- **NO** activar `STRIPE_LIVE_ENABLED`, `STRIPE_FINANCIAL_WRITES_ENABLED`,
  `STRIPE_CONNECT_TRANSFERS_ENABLED` ni pagos/transferencias LIVE.
- Conservar las reglas de `/etc/cloudflared/config.yml`: rutas legales
  `/privacidad` y `/eliminar-cuenta` en 18191, API Node en 18190.
- Sin despliegue de apps Android, ni cambio a las cuentas Stripe.
- Ningún comando permitido usa `prisma migrate deploy` automáticamente.
- La operación `--apply` es deliberadamente **mutante**, con aprobación separada.

## A. Revisión inicial en Kali (sin modificar runtime)

Desde `alan`:

```bash
sudo -iu tala-node-stage
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
id -un
node --version
pm2 list
stat -c '%a %U' "$HOME/.config/talaeats-node-staging.env"
curl -fsS http://127.0.0.1:18190/api/v1/ready |
  python3 -c 'import json,sys; v=json.load(sys.stdin); print("READY",v.get("ready"),"WORKER",v.get("workerOnline"),"LIVE_WRITES",v.get("financialWrites"))'
```

Nunca pegar ni imprimir el contenido de la configuración privada.

## B. Clonar release a directorio inmutable de staging

*Usar el SHA exacto aprobado de HEAD en PR #157, después de CI PASS.
No usar el SHA de una versión intermedia.*

```bash
BRANCH="fix/rc812-ready-worker-gate-20261024"
SHA="<SHA_FINAL_40_CARACTERES>"
REPO="https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend.git"
RELEASE="$HOME/tala-node-releases/$SHA"
test "$(id -un)" = tala-node-stage
test ! -e "$RELEASE"
git clone --depth 1 --branch "$BRANCH" "$REPO" "$RELEASE"
test "$(git -C "$RELEASE" rev-parse --verify HEAD)" = "$SHA"
cd "$RELEASE/node-backend"
bash scripts/rc812-kali-stage-release.sh --prepare "$SHA"
bash scripts/rc812-kali-stage-release.sh --plan "$SHA"
```

`--prepare` crea node_modules y compila **solo dentro del nuevo checkout**,
ejecuta Prisma **validate** y pruebas Node completas. No altera la base,
PM2 ni Stripe; el único cambio en disco es el release nuevo.

`--plan` requiere PostgreSQL 15 **real** (no se basa solo en la URL), Redis,
PM2 actual en línea, esquema Prisma completo y backups/migraciones compatibles.

Si el plan muestra `ABORT_PG15_STAGING_IDENTITY`,
`RC811_ABORT=PRISMA_MIGRATIONS_PENDING_OR_DIVERGENT` u otro HOLD:
**DETENERSE**; no cambiar env de stage para ocultar la divergencia ni apuntar
a PostgreSQL LIVE. Verificar versión real y revisar migraciones antes de actuar.

## C. Migraciones SOLO si staging PG15 lo requiere (operación separada)

```bash
bash scripts/rc811-stage-schema-gate.sh --plan "$SHA"
```

El `--apply` de migración existe, pero requiere revisión humana de diff SQL
y compatibilidad del runtime anterior: corre backup + restore en scratch y
modifica tablas staging. NO ejecutar a ciegas.

## D. Activación PM2, solo después de PASS en plan y aprobación

```bash
bash scripts/rc812-kali-stage-release.sh --apply "$SHA" I_APPROVE_RC812_STAGE_PM2_ONLY
```

El promotor de RC8.12 verifica SHA, roles y env 0600; repite pruebas y plan,
realiza respaldo y restauración de PostgreSQL 15, conserva punto de retorno
de PM2, sustituye solamente API/worker y valida el despliegue. Para adaptarse
al gate RC8.12:
1. detiene los dos procesos staging existentes,
2. elimina solamente el **heartbeat Redis** del worker antiguo,
3. arranca worker nuevo y verifica un heartbeat `online` reciente,
4. arranca API nueva y espera `ready=true` con `workerOnline=true`,
5. ejecuta smoke y auditor RC8.9.

**No hay tiempo de inactividad cero:** el puerto público 18190 puede devolver
503/errores durante la breve conmutación. Si existen usuarios o webhooks
usándolo, elegir una ventana segura. Si falla durante cutover, intenta restaurar
la versión de PM2 previa (worker antes de API); una reversión posterior exige
revisión de órdenes y datos. Nunca restaurar automáticamente la base de datos
con un dump sobre órdenes posteriores al cambio.

## E. Verificaciones inmediatas en Kali, solo lectura

```bash
bash scripts/rc812-kali-stage-release.sh --verify "$SHA"
curl -fsS -o /dev/null -w 'API_LOCAL %{http_code}\n' \
  http://127.0.0.1:18190/api/v1/ready
curl -fsS -o /dev/null -w 'API_PUBLIC %{http_code}\n' \
  https://talaeats.alan-palacios-dev.com/api/v1/ready
curl -fsS -o /dev/null -w 'PRIVACIDAD %{http_code} %{content_type}\n' \
  https://talaeats.alan-palacios-dev.com/privacidad
curl -fsS -o /dev/null -w 'ELIMINACION %{http_code} %{content_type}\n' \
  https://talaeats.alan-palacios-dev.com/eliminar-cuenta
```

Esperado: los cuatro endpoints HTTP 200. Ambos legales en `text/html`;
API `application/json`. `rc89-stage-postdeploy-check.sh` también valida
SHA exacto, PM2/worker, aislamiento financiero, READY backlog y controles
de acceso, sin filtrar datos privados.

## F. Pruebas de funcionalidades después del despliegue

**Primer lote sin dinero real ni modificaciones de base:**
- Revisión de `health/ready` local/público.
- Confirmación de permisos de roles de Usuarios, Restaurante, Repartidor.
- Comprobación de catálogo/consulta de cotizaciones y recuperación por
  `client_reference`, utilizando cuentas de ensayo.
- Estado del worker, reconciliación pendiente y backlog READY mediante
  auditoría solo lectura.

**Segundo lote controlado en una base desechable o tenant de ensayo**,
tras respaldos y autorización para crear pedidos sintéticos:
- efectivo cliente → comerciante confirma/prepara/READY →
  repartidor disponible con GPS vigente → recoge → PIN → entregue →
  saldo financiero y propina exactamente una sola vez.
- Stripe TEST con evento real firmado + replay/decline, NUNCA `sk_live_`
  ni Transferencias Connect. Los workflows de Actions simulan partes de
  la cadena; no equivalen a un pago físico en el servidor.
- Prueba de pérdida de heartbeat **solo en laboratorio aislado**, NUNCA
  apagando el worker de pedidos públicos para demostrar un 503.
- Verificación Firebase FCM real en teléfono y cambio de estados.

El resultado de staging no autoriza lanzamiento comercial ni cobros LIVE.
