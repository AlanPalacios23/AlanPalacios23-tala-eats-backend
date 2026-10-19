# TALA EATS · Kali Node/PM2 staging — primera puesta en marcha verificada

**Fecha de evidencia:** 19-oct-2026 UTC. **Alcance:** exclusivamente staging nativo; NO despliegue productivo.

## Pruebas presentadas directamente por el operador desde Kali

- Usuario Linux aislado: `tala-node-stage`.
- Código en `/home/tala-node-stage/talaeats-node-source`, commit usado para la instalación `798da93a05e328a1a08ac687834b5664fff421fd` (rama PR #80).
- PostgreSQL 15.19 nativo compilado en HOME de staging. Cluster local ya inicializado, autenticación PostgreSQL y consulta real PASS, puerto `127.0.0.1:15435`.
- Redis 8 nativo aislado en `127.0.0.1:16379`, autenticación + PING PASS.
- Entorno privado (modo 0600) bajo HOME staging. No copiar a GitHub ni imprimir las credenciales.
- Node.js `v24.22.0`, npm `11.19.1`, PM2 `6.0.14`, instalados bajo usuario staging; SHA256 Node PASS.
- `npm ci` instaló 259 paquetes, Prisma 7.10.0 generó cliente y validó esquema; la migración `20261019_initial` fue aplicada sin errores a PostgreSQL staging.
- `npm run build`: PASS. `npm test`: **6/6 PASS**.
- `kali-staging-deploy.sh --preflight`: PASS sin cambios; `--apply`: inició únicamente la API PM2; readiness PASS antes de iniciar el worker PM2.
- `pm2 status`: `tala-node-stage-api` online, cero reinicios; `tala-node-stage-worker` online, cero reinicios.
- `curl http://127.0.0.1:18190/api/v1/health`: `{"status":"ok","version":"0.1.0-node-stage","production":false}`.
- `curl http://127.0.0.1:18190/api/v1/ready`: `{"ready":true,"database":true,"redis":true,"financialWrites":false}`.
- Scripts imprimieron aislamiento de Docker/PG18/Stripe LIVE; **esto no reemplaza una auditoría independiente de producción**.

## GO/NO-GO

| Capacidad | Estado |
| --- | --- |
| API Node/Express + PM2 local | **PASS real en Kali** |
| Worker PM2 iniciado | **PASS online** |
| PostgreSQL15 nativo, Redis8 | **PASS conectividad real** |
| Migración Prisma inicial en staging | **PASS real** |
| CI Node24/Prisma/PG15/Redis/BullMQ/Stripe TEST | PASS previo en GitHub (ambiente CI) |
| Webhook Stripe TEST end-to-end en este Kali | **NO probado aún en Kali** (CI sí) |
| Arranque de PostgreSQL, Redis y PM2 tras reiniciar Kali | **NO configurado** |
| Autodeploy GitHub → PM2 Node | **NO activado**; PR #79 es agente Python obsoleto |
| Auth, catálogo, pedidos, dispatch, Connect, pagos y retiros reales | **NO implementados en la versión Node v0.1.0** |
| API pública V3 anterior | **No corregida por staging Node**; última prueba directa HTTP 502 |

## Próxima fase recomendada

1. Confirmar estado y salud sostenidos; ejecutar prueba segura de worker/cola en staging con eventos sintéticos y sin movimientos financieros.
2. Preparar arranque/reinicio durable (systemd o unidades equivalentes por usuario) para **estos tres componentes exclusivos staging**, con reversión controlada; no usar `pm2 startup` o `pm2 save` sin revisión y aprobación.
3. Preparar backups + restore de DB staging, métricas, reinicios, límites y alertas.
4. Integrar de forma incremental contratos originales API/Flutter/Admin con pruebas de regresión y aislar Stripe TEST. **No redirigir tráfico público** hasta paridad real.
5. Crear nuevo agente GitHub → PM2 **para Node**, limitado a staging, builds SHA-fijados, CI PASS y rollback probado. **No fusionar PR #79 FastAPI/Python** como agente Node.

## Notas

Las advertencias npm sobre `cron-parser` y scripts de instalación de tres paquetes **no bloquearon** las pruebas ni la puesta en marcha; deberán revisarse antes de una release productiva. La versión de Prisma 8 aparece como RC, por lo que se mantiene el pin de Prisma 7.10.0. No se difundieron secretos.
