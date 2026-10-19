# TALA EATS — Ejecución Kali: Node 24 + PM2 + PostgreSQL 15 y Redis NATIVOS

**No se ha desplegado esto en Kali.** Este procedimiento es para staging privado, NO sustituye todavía la API pública Python. Para cambios reales, cada `--apply` exige una aprobación distinta; no ejecutarlos conjuntamente ni sin revisar el resultado de `--plan`.

Proyecto público: `AlanPalacios23/AlanPalacios23-tala-eats-backend` · PR #80 · rama `feat/node24-pm2-native-staging-20261019`.

## Estado GitHub

- Node 24 / Prisma 7 / TypeScript / pruebas estáticas PASS.
- Integración CI sobre PostgreSQL **15**, Redis **8**, migración Prisma y webhook de Stripe firmado de prueba con worker BullMQ: PASS.
- Sólo reciben claves Stripe TEST. La API `/api/v1/health` y `/api/v1/ready` será **staging**, en `127.0.0.1:18190`.
- API de producción antigua aún tenía 502 en la última comprobación real; este nuevo backend NO corrige ni reemplaza automáticamente esa API.

## Fase 0: inspección en Kali — sin modificaciones

Desde la sesión administrativa del operador `alan`:

```bash
git clone --branch feat/node24-pm2-native-staging-20261019 --single-branch \
  https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend.git \
  "$HOME/tala-node-staging-prep"
cd "$HOME/tala-node-staging-prep"
bash node-backend/scripts/kali-native-preflight.sh
bash node-backend/scripts/kali-provision-native-stage.sh --plan
apt-cache policy postgresql-15 redis-server
```

No compartir datos de credenciales, URL de producción ni archivos `.env.production`. Verificar que los puertos **15435, 16379 y 18190 estén libres**, que el usuario `tala-node-stage` todavía no exista y que no haya cluster `15/tala_node_stage` previo. Comprobar que Docker GREEN/V3, Caddy y Cloudflare seguirán intactos.

## Fase 1: binarios nativos y dependencia PostgreSQL 15

No ejecutar un `apt install` genérico de PostgreSQL/Redis a ciegas. Primero revisar `apt-cache policy`, servicios host y `apt-get -s install postgresql-15 postgresql-client-15 redis-server`.

Instalar binarios nativos sólo si la simulación, los repositorios y el operador confirman que los paquetes no reiniciarán ni reemplazarán servicios existentes. Kali puede no ofrecer `postgresql-15` en su repositorio actual; **NO** añadir PGDG sin revisar el codename Debian y los efectos del paquete. Una instalación Debian puede crear o habilitar instancias por defecto: detectarlas antes, y no usar puerto 5432. La preparación no depende de Docker.

## Fase 2: crear únicamente el staging nativo — requiere autorización administrativa

Después de comprobar las precondiciones, el aprovisionador `node-backend/scripts/kali-provision-native-stage.sh` permite, con aprobación explícita, crear:
- usuario aislado `tala-node-stage` sin sudo/Docker;
- cluster PostgreSQL 15 `tala_node_stage`, loopback puerto **15435**, nueva DB/rol del mismo nombre;
- Redis nativo dedicado `tala-node-stage-redis`, loopback puerto **16379**, unidad systemd propia;
- secretos aleatorios nuevos en `/home/tala-node-stage/.config/talaeats-node-staging.env`, permiso 0600.

**Sólo tras revisar `--plan` y autorizar la operación:**

```bash
sudo env TALA_NATIVE_STAGE_APPROVAL=I_APPROVE_NEW_NATIVE_STAGE_ONLY \
  bash node-backend/scripts/kali-provision-native-stage.sh --apply
```

Esta operación sí modifica el host: crea usuario, cluster, Redis y systemd. No afecta voluntariamente los recursos Docker, pero requiere ventana y vigilancia operativa. **No ejecutarla desde una sesión automatizada sin supervisión.**

## Fase 3: instalar Node 24 y PM2 en la cuenta de staging

La cuenta de staging usa su propio home, sin acceso a Docker ni Stripe LIVE.

```bash
sudo -iu tala-node-stage
git clone --branch feat/node24-pm2-native-staging-20261019 --single-branch \
  https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend.git \
  "$HOME/talaeats-native"
cd "$HOME/talaeats-native"
bash node-backend/scripts/kali-install-node24-user.sh --plan
```

Después de aprobar el resultado de esa planificación:

```bash
TALA_NODE24_USER_APPROVAL=I_APPROVE_STAGE_USER_ONLY \
  bash node-backend/scripts/kali-install-node24-user.sh --apply
source "$HOME/.profile"
cd node-backend
npm ci --no-audit --no-fund
npm run generate
npm run db:validate
npm run build
npm test
```

Instalador de usuario: descarga Node 24 de nodejs.org, verifica SHA256 oficial e instala PM2 en `~/.local`. No cambia Node global, no configura `pm2 startup` ni arranca procesos. **No hay instalador alternativo autorizado.**

## Fase 4: migración de la DB NUEVA de staging

```bash
bash scripts/kali-stage-migrate.sh --preflight
```

El guard comprueba desde SQL la versión PostgreSQL **15**, el usuario/DB exclusivos y el puerto 15435; aborta si no coincide. Sólo tras verificación y aprobación explícita:

```bash
TALA_STAGE_MIGRATE_APPROVAL=I_APPROVE_NEW_STAGE_SCHEMA_ONLY \
  bash scripts/kali-stage-migrate.sh --apply
```

No usar `db push`, `migrate reset`, restaurar archivos Docker ni copiar migraciones Python. Se implementa sólo esquema preliminar de webhooks, Connect y retiros no activos.

## Fase 5: iniciar API y worker con PM2, sólo si DB staging está migrada

```bash
bash scripts/kali-staging-deploy.sh --preflight
```

Tras obtener PASS de la migración, pruebas locales y autorización separada:

```bash
TALA_STAGE_START_APPROVAL=I_APPROVE_LOCAL_STAGE_PM2_ONLY \
  bash scripts/kali-staging-deploy.sh --apply
```

Este script inicia primero API, exige `ready=true` y `financialWrites=false`, y **después** inicia worker. No redirige Caddy ni Cloudflare a staging, no cambia puertos públicos y no crea persistencia `pm2 startup`.

```bash
pm2 ls
curl --fail --silent http://127.0.0.1:18190/api/v1/health
curl --fail --silent http://127.0.0.1:18190/api/v1/ready
```

## Antes de producción pública

No hay paridad funcional aún con las apps Flutter y Admin: faltan autenticación, pedidos, menú, reparto, ledger y los contratos de los endpoints existentes. **No cambiar el DNS LIVE** ni activar cobros, Stripe Connect o payouts. El agente de despliegue Python de la PR #79 queda desalineado; construir un agente Node separado sólo después de aprobar staging y las migraciones.
