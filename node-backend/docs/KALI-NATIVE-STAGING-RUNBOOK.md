# Kali: staging nativo aislado — preparación, NO despliegue productivo

El host Kali existente usa Docker V3/GREEN, Caddy, Redis y PostgreSQL productivos. Este stack Node debe quedar completamente independiente. La API V3 fue observada con HTTP 502; preparar Node **no** la repara ni implica cambiar tráfico.

| Componente | Nueva instalación staging |
|---|---|
| Node.js / PM2 | Node 24 LTS y PM2 de usuario Linux no privilegiado |
| API | 127.0.0.1:18190 |
| PostgreSQL | PostgreSQL **15 nativo**, cluster NUEVO `tala_node_stage`, 127.0.0.1:15435, rol/DB `tala_node_stage` |
| Redis | Nueva instancia **nativa** y separada en 127.0.0.1:16379 con contraseña propia |
| Stripe | TEST únicamente, operaciones financieras deshabilitadas |

## 1. Inventario de solo lectura

Desde la raíz del repositorio:
```sh
bash node-backend/scripts/kali-native-preflight.sh
```

Verificar estado de puertos 15435, 16379, 18190; ram y CPU disponible. El Kali observado tenía recursos limitados (2 CPU, ~6.7 GiB RAM), así que no incrementar de golpe la presión de memoria.

## 2. Node 24 y PM2

Instalar Node 24 LTS desde distribución oficial o gestor verificado para el **nuevo usuario staging**. No actualizar Node de otras apps de Kali ni usar sudo para PM2. Verificar `node -v` (>=24.11 dentro de rama 24). `npm install -g pm2` solo cuando `npm prefix -g` pertenezca al usuario staging. No ejecutar `pm2 startup` ni `pm2 save` sin aprobación específica.

## 3. PostgreSQL 15 nativo

Como administrador, primero:
```sh
apt-cache policy postgresql-15
pg_lsclusters
ss -ltn | grep ':15435' || true
```

No instalar paquete `postgresql` sin versión (Kali puede resolver otra versión). Si PostgreSQL 15 no está en repositorios, revisar repositorio oficial PGDG compatible con Kali **antes** de añadirlo. En una ventana administrativa aprobada, con 15435 libre, crear cluster **nuevo**, no reutilizar directorios ni clusters de V3/GREEN:
```sh
# SOLO DESPUÉS DE AUTORIZAR:
# sudo apt-get install postgresql-15 postgresql-client-15
# sudo pg_createcluster 15 tala_node_stage --port 15435 --start-conf=manual
# En postgresql.conf de ESE cluster:
# listen_addresses = '127.0.0.1'
# password_encryption = 'scram-sha-256'
# pg_hba.conf: permitir sólo SCRAM para rol/db staging desde 127.0.0.1/32
# sudo pg_ctlcluster 15 tala_node_stage start
```

Crear usuario/DB dedicado sin SUPERUSER, CREATEDB, CREATEROLE o REPLICATION, contraseña nueva mediante método interactivo que no la exponga en historial. Probar PostgreSQL 15, puerto y rol/DB correctos. Nunca iniciar cluster PostgreSQL15 sobre directorio de PostgreSQL16. Nunca pasar este nuevo backend a la DB Docker productiva.

## 4. Redis nativo nuevo

Comprobar `apt-cache policy redis-server` y puertos. No alterar un Redis existente en 6379. Tras aprobación instalar sólo el binario Redis y crear instancia separada en 16379, `bind 127.0.0.1`, `protected-mode yes`, contraseña/ACL propia, directorio de datos privado y systemd propio bajo cuenta sin privilegios. No copiar snapshots, contraseñas ni colas Redis de V3/GREEN. Evitar que la instalación habilite un servicio Redis por defecto en 6379 inadvertidamente.

## 5. Configuración fuera de Git

```sh
mkdir -p -m 700 ~/.config
umask 077
# Crear localmente ~/.config/talaeats-node-staging.env
# Guiarse por node-backend/.env.example sin copiar claves LIVE.
chmod 600 ~/.config/talaeats-node-staging.env
```

Node 24 lee este archivo con `--env-file`. No se hace `source` (evita evaluación de shell no deseada). Prisma necesita DATABASE_URL staging para `generate`, `validate` y `migrate deploy`; nunca `db push` o `migrate reset` en una DB de producción.

## 6. Deployment gate

```sh
cd node-backend
bash scripts/kali-staging-deploy.sh --preflight
# --apply NO está permitido hasta existir package-lock.json
# versionado y migraciones revisadas de una DB staging confirmada nueva.
```

Para cualquier cambio con `--apply`: aprobación explícita, commit/CI verificado, respaldo de staging, plan de rollback. PM2 debe controlar sólo API y worker de staging. Verificar loopback /health y /ready antes de pensar en DNS separado. Estrictamente NO cambiar el DNS LIVE, servicios Caddy, Cloudflare, Docker V3/GREEN o Stripe LIVE.

## 7. Autosync futuro

La PR #79 fue diseñada para FastAPI/Python: **NO FUSIONAR** para Node. Agente Node nuevo requerirá SHA exacto, CI verde, mínimo privilegio, sólo staging, y autorización separada para migraciones. Prohibido habilitar reintentos ciegos de retiros; exigir idempotencia + conciliación.
