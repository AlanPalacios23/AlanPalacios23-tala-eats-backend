# TALA EATS — estado operativo Kali: Node RC6 público y retiro del Python legado

**Corte de evidencias:** noche del 21 de octubre de 2026 (CDMX) / 22 de octubre de 2026 UTC.  
**Fuente:** salidas de terminal entregadas por el operador desde Kali. **No** constituye acceso SSH ni una auditoría independiente desde GitHub.  
**Propósito:** fuente de verdad operativa para el dominio público de Tala Eats y el inventario de legado, sin confundir este documento con una autorización comercial.

> **Estado comunicado y verificado mediante comandos ejecutados en Kali:** el hostname HTTPS de Tala Eats llega a **Node.js RC6**, la API/worker de staging pasaron smoke, y los **seis contenedores Docker del proyecto Python antiguo fueron eliminados**. **No** se eliminaron sus volúmenes, imágenes Docker, releases en disco ni datos históricos. No se confirmó migración de datos Python→Node ni funcionamiento integral de las aplicaciones.

## 1. Única API pública de Tala Eats

| Elemento | Valor documentado |
| --- | --- |
| API base externa para las tres apps | `https://talaeats.alan-palacios-dev.com/api/v1` |
| Readiness público | `https://talaeats.alan-palacios-dev.com/api/v1/ready` |
| Origen HTTP **local**, no abrir el puerto a Internet | `http://127.0.0.1:18190/api/v1` |
| Servicio de túnel | `cloudflared` de sistema, `/etc/cloudflared/config.yml` |
| Regla de ingress comprobada | `hostname: talaeats.alan-palacios-dev.com` → `service: http://127.0.0.1:18190` |
| Release Node realmente ejecutado en Kali | `30ab51b587b21127c3f3419e0ec4c3a8539dfb0a` |
| Release en disco | `/home/tala-node-stage/tala-node-releases/30ab51b587b21127c3f3419e0ec4c3a8539dfb0a/node-backend` |
| Usuario Linux dedicado | `tala-node-stage` |
| PM2 | `tala-node-stage-api` y `tala-node-stage-worker` |
| PostgreSQL exclusivo Node | PostgreSQL 15 nativo, `127.0.0.1:15435`, DB `tala_node_stage` |
| Redis exclusivo Node | Redis 8 nativo, `127.0.0.1:16379`, DB Redis `/0` |
| Configuración sensible de Node | `/home/tala-node-stage/.config/talaeats-node-staging.env`, modo 0600; **no subir su contenido** |
| Unidades systemd **de usuario** | `tala-node-stage-pg15.service`, `tala-node-stage-redis.service` y `tala-node-stage-pm2.service`, reportadas `active`/`enabled` |
| Otros proyectos de Kali | Fuera del alcance; no eliminar ni modificar sus contenedores, rutas o bases de datos |

La IP `127.0.0.1` es deliberada: **Cloudflare Tunnel expone HTTPS y reenvía al socket loopback**. No cambiar `HOST=127.0.0.1` a `0.0.0.0` ni publicar el puerto 18190 en firewall, Docker o NAT.

### Contrato de disponibilidad observado

El operador ejecutó `curl -fsS https://talaeats.alan-palacios-dev.com/api/v1/ready` **después** de retirar Docker y recibió:

```json
{
  "ready": true,
  "database": true,
  "redis": true,
  "workerOnline": true,
  "productionReady": false,
  "environment": "staging",
  "financialWrites": false,
  "digitalPaymentProvider": "stripe",
  "onlinePaymentsEnabled": false
}
```

Éxitos observados en la publicación: `RUTA_NODE_RC6_CONFIGURADA=PASS`, `NODE_RC6_PUBLICO=PASS` y `CLOUDFLARE_NODE_RC6=PASS`. La comprobación se repitió después de retirar los contenedores y siguió dando `NODE_PUBLICO=PASS`. **Una respuesta correcta del endpoint `ready` verifica conectividad/servicios, no todos los flujos de negocio**.

### Cómo se solucionó el problema HTTP 502/530

- Node respondió correctamente en `127.0.0.1:18190`, pero la URL pública devolvía `502` mientras el túnel seguía usando el origen antiguo.
- Se identificó `cloudflared` activo y `--config /etc/cloudflared/config.yml`; la regla se validó con `cloudflared tunnel ingress validate` e `ingress rule` (coincidencia de regla `#0`).
- Tras el reinicio de `cloudflared` se observó inicialmente `530` mientras se reconectaba el túnel; un intento posterior devolvió JSON Node válido y `NODE_RC6_PUBLICO=PASS`.
- El registro de `cloudflared` mostró conexiones QUIC registradas. El error por `cert.pem` de `cloudflared tunnel list` **no** equivale a que el túnel existente no pueda servir tráfico.
- La regla final queda vinculada a Node; no editar las reglas de CODEXIA, NOCTRA, DATECLUB u otros servicios.

No volver a mover `talaeats.alan-palacios-dev.com` al puerto 8082 ni levantar el stack Python como alternativa automática sin un plan explícito de datos, compatibilidad y seguridad.

## 2. Despliegue RC6 de Node (evidencia desde Kali)

- GitHub RC6 fuente: rama `feat/node-kali-direct-pm2-release-20261020`, PR [#123](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/pull/123), SHA operativo **fijado** `30ab51b587b21127c3f3419e0ec4c3a8539dfb0a`.
- `npm ci`, `prisma generate`, `prisma validate`, `tsc`, y `npm test`: **21/21 PASS** en Kali.
- **23 migraciones Prisma** aplicadas en la DB PostgreSQL 15 Node; las dos últimas fueron `20261020_admin_helpdesk_reply` y `20261021_driver_verification_fail_closed`.
- Respaldo de la DB de **staging Node** y restauración real en PG15 temporal **socket-only**: `SCRATCH_FULL_RESTORE=PASS`. Esta prueba **no** cubre el respaldo legado de PostgreSQL 16 Python.
- `FIRST_NODE_PM2_STAGE_PROMOTION=PASS`, `ACTIVE_NODE_SHA=30ab51b587b21127c3f3419e0ec4c3a8539dfb0a`.
- Smoke posterior y repetido: `PM2_API_WORKER_SHA=PASS`, `STAGE_WORKER_HEARTBEAT=PASS`, `STAGE_MARKET_ISOLATION=PASS` y `KALI_NODE_PM2_STAGE_POSTDEPLOY_SMOKE=PASS`.
- Se observaron `tala-node-stage-api` y `tala-node-stage-worker` online con cero reinicios al comprobar PM2. No constituye una medición de estabilidad a largo plazo.
- No se ejecutó Stripe LIVE; `financialWrites=false` y `onlinePaymentsEnabled=false`.

**Versionado:** el SHA anterior es el **código activo en Kali**, aunque GitHub reciba después commits **solo de documentación**. Cambiar un documento o la punta de la rama **no** despliega ni actualiza PM2.

## 3. Retiro comprobado del Docker Python legado

Antes de la limpieza, el operador observó estos seis contenedores con etiqueta Compose `com.docker.compose.project=talaeats-v3`:

| Contenedor retirado | Estado previo |
| --- | --- |
| `talaeats-v3-backend-1` | `Restarting (1)`, backend Python `v1.6.4-hf1` |
| `talaeats-v3-worker-1` | `Up`, worker Python `v1.6.4-hf1` |
| `talaeats-v3-caddy-1` | `Up` |
| `talaeats-v3-frontend-1` | `Up (healthy)` |
| `talaeats-v3-redis-1` | `Up (healthy)`, Redis 8 Docker |
| `talaeats-v3-db-1` | `Up (healthy)`, PostgreSQL 16 Docker |

El operador ejecutó una retirada acotada: verificación del dominio Node, validación de etiquetas Docker de los seis contenedores, `docker update --restart=no`, detención de Python API/worker, respaldo de PG16 y media, segunda verificación Node, detención restante y `docker rm` de esos seis nombres exactos. Resultados:

```text
NODE_PUBLICO=PASS
POSTGRES_BACKUP_ARCHIVE=PASS
MEDIA_BACKUP_ARCHIVE=PASS
LEGACY_CONTAINERS_REMOVED=PASS
LEGACY_VOLUMES_PRESERVED=YES
```

`docker ps -a --filter label=com.docker.compose.project=talaeats-v3` no mostró contenedores después. **Eliminar contenedores no implica borrar sus imágenes, volúmenes ni directorios.** Tampoco prueba que no exista una tarea de cron/Compose externa capaz de recrearlos.

### Respaldo del Python antiguo (retener)

Directorio privado confirmado por el operador: `/home/alan/talaeats-legacy-backups/pre-node-RPzsLYxx/`.

| Archivo | Tamaño reportado | Alcance comprobado |
| --- | --- | --- |
| `postgres16.dump` | 321 KiB | `pg_dump -Fc` y `pg_restore --list` PASS (índice legible; **no** se comprobó restauración completa de PG16) |
| `media.tar.gz` | 2.7 MiB | `tar -tzf` PASS (índice legible; **no** se verificó restauración completa/consistencia con DB) |

Estos archivos se mostraron con permisos `-rw-------` de `root`. **No versionar, publicar, enviar a CI ni borrar** el dump y la media: pueden contener información personal o comercial. Se desconoce si todas las cuentas, restaurantes, productos, fotografías, pedidos, saldos e historiales del Python están en Node. No se ejecutó ni probó una migración de datos entre PG16 Python y PG15 Node.

### Los cinco volúmenes Python aún existentes

```text
talaeats-v3_caddy_config
talaeats-v3_caddy_data
talaeats-v3_talaeats_media
talaeats-v3_talaeats_postgres
talaeats-v3_talaeats_redis
```

**Conservar especialmente** `talaeats-v3_talaeats_postgres` y `talaeats-v3_talaeats_media` hasta restauración cruzada, reconciliación de datos y aprobación de retención. No usar `docker compose down -v`, `docker volume prune` ni `docker system prune --volumes`. Caddy/Redis también requieren comprobar dependencias antes de eliminar sus volúmenes.

### Imágenes Docker anteriores todavía en Kali

El inventario mostró etiquetas de `talaeats-candidate`, `talaeats-rollback/backend`, `talaeats-rollback/worker`, `talaeats-v3-backend`, `talaeats-v3-worker`, `talaeats-v3-frontend` y `talaeats-admin` (incluidos tags `rollback`, `respaldo`, `pre-v` y `before-*`). **No** se eliminaron imágenes con la retirada anterior.

Antes de `docker image rm`, comprobar referencias de **todos** los contenedores de la máquina y tags compartidos. La eliminación de imágenes ocupa una fase distinta; no ejecutar `docker image prune -a` de forma global.

### Carpetas antiguas inventariadas; no eliminadas

El operador encontró, entre otras:

- `/home/alan/talaeats-releases/`, con releases Python `v1.6.0`, `v1.6.1`, `v1.6.2`, `v1.6.3` y `v1.6.4`.
- `/home/alan/talaeats-v3/`, `/home/alan/talaeats-v31/`, `/home/alan/talaeats-green-20261018/`.
- `/home/alan/talaeats-admin-releases/` y directorios `TalaEats-ADMIN-v1.5.1-*` / `TalaEats-ADMIN-v1.5.2-*`.
- `/home/alan/talaeats-backups/` y `/home/alan/talaeats-legacy-backups/`.
- `/home/alan/talaeats-node-stage-prep/`, más carpetas `TalaEats-V11-*PATCH*`.
- `/home/alan/.ssh/talaeats-ci/`: **llaves o material de acceso; jamás borrar ni subir a GitHub sin auditar su uso**.

No confundir ninguno de estos directorios históricos con el worktree **activo** en `/home/tala-node-stage/tala-node-releases/<SHA>/node-backend`.

En `systemctl list-unit-files` y `systemctl list-timers` filtrados por `talaeats|tala-eats` no aparecieron entradas durante ese inventario. Esto **no descarta** cron, user timers, otros nombres de units o tareas externas.

## 4. Configuración de las apps Flutter: una URL, compatibilidad pendiente

Las apps **Usuarios, Restaurante y Repartidor** del repositorio `AlanPalacios23/tala-eats-mobile` tenían configurada como URL predeterminada `https://talaeats.alan-palacios-dev.com/api/v1`, por lo que **el hostname coincide ahora con el Node publicado**:

| Cliente | Define de compilación / constante |
| --- | --- |
| Usuarios | `TALAEATS_API_BASE_URL` → `kProductionApiBase` |
| Restaurante | `TALA_EATS_API_BASE` → `kApiBase` |
| Repartidor | `TALA_EATS_API_BASE` → `kApiBase` |

Las builds instaladas podrían contener un `--dart-define` distinto, y tokens/sesiones anteriores del Python **no son garantía de compatibilidad** con Node. Verificar APK/AAB de cada rol, certificados HTTPS, JWT/sesión y permisos **en dispositivos de prueba**. **No** colocar `127.0.0.1:18190` en una APK: en un móvil apunta al propio dispositivo.

La publicación HTTPS **no** acredita paridad funcional. Se necesita QA de registro/login, catálogo por localidad, KDS, soporte, comercios, imágenes, pagos TEST, stock, idempotencia, reparto y ADMIN (separado de las tres apps). El portal ADMIN antiguo puede haberse quedado sin backend al retirar Docker; revisar su ruta y autenticación por separado.

## 5. Riesgos que siguen abiertos — NO-GO para usuarios comerciales

**Node RC6 publicado sigue siendo un entorno `staging` con una URL accesible externamente.** Un HTTP 200 no cambia sus bloqueos.

- `productionReady=false`, `financialWrites=false`, `onlinePaymentsEnabled=false`: no hay cobros/reembolsos/liquidaciones Stripe reales.
- La correspondencia de firmas Python→Node (249/252, más tres endpoints de Mercado Pago retirados) **no prueba equivalencia funcional**: existen rutas incompletas / respuestas `503`.
- Falta acreditar ciclo completo de delivery con repartidores reales, GPS/PIN, idempotencia, webhook y ledger financieros TEST, notificaciones, MFA/soporte, cuentas reales e inventario.
- Los datos de PG16 Python y medios históricos **no** fueron reconciliados ni migrados al PG15 Node. No afirmar que comerciantes o pedidos antiguos estarán visibles.
- Al publicar staging se debe revisar exposición de rutas administrativas, rate limits, CORS, control de acceso y protección de cuentas sintéticas antes de compartir la URL o distribuir APKs.

**El retiro de Docker sí se ejecutó a petición del operador.** Que no haya ya API Python activa no autoriza un lanzamiento comercial de Node ni habilitar Stripe LIVE.

## 6. Diagnóstico y seguimiento SIN modificar servicios

**Como `alan`:**

```bash
# HTTPS sirve Node y tiene las marcas correctas
curl -fsS --max-time 10 https://talaeats.alan-palacios-dev.com/api/v1/ready

# Servicio local Node (desde el host Kali)
curl -fsS --max-time 5 http://127.0.0.1:18190/api/v1/ready

# Ver qué origen selecciona la regla de Tala Eats
sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress rule \
  https://talaeats.alan-palacios-dev.com/api/v1/ready

# Los seis contenedores antiguos deben continuar ausentes
sudo docker ps -a --filter label=com.docker.compose.project=talaeats-v3 \
  --format '{{.Names}} {{.Status}}'

# Estado Cloudflare (sin imprimir configuración sensible)
systemctl is-active cloudflared
```

**Como `tala-node-stage`:**

```bash
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
cd "$HOME/tala-node-releases/30ab51b587b21127c3f3419e0ec4c3a8539dfb0a/node-backend"
bash scripts/kali-stage-postdeploy-smoke.sh 30ab51b587b21127c3f3419e0ec4c3a8539dfb0a
pm2 status
```

No ejecutar `pm2 restart`, `prisma migrate`, `docker compose up`, `docker compose down -v`, `rm -rf` ni escribir secretos durante una consulta de estado. Si un servicio reaparece, inventariar su origen (Compose, crontab, user systemd, GitHub Actions o script local) **antes de volver a eliminarlo**.

### Recomendación de etapas siguientes

1. **Seguridad del staging público:** limitar cuentas a QA, revisar accesos privilegiados y rutas sensibles. Monitorear Node/worker durante el período de prueba.
2. **Compatibilidad Flutter:** probar las tres apps y el ADMIN contra `https://talaeats.alan-palacios-dev.com/api/v1` en dispositivos reales, sin dinero ni cuentas comerciales.
3. **Datos legado:** verificar restauración completa del dump PG16 y del archivo media en entorno aislado; inventariar diferencias contra PG15 Node antes de considerar eliminación definitiva de volúmenes o backups.
4. **Limpieza final:** documentar hashes, dependencias y propietario de imágenes/directorios; borrar únicamente recursos huérfanos específicos tras verificación, sin `prune` general. Conservar un registro de qué se eliminó.
5. **Lanzamiento real:** terminar y aprobar pagos, pedidos y entregas reales; prueba de carga, seguridad, observabilidad, rollback, compatibilidad y estrategia de datos. **Sin estas puertas, NO-GO comercial.**

## 7. Alcance de este registro en GitHub

Este documento describe operaciones **ya realizadas manualmente por el operador en Kali** y sus salidas. Guardarlo o actualizar el README **no cambia** Cloudflare, Docker, PM2, PostgreSQL, Redis, ni las APK. La punta de la rama Git podrá avanzar con documentación mientras Kali siga ejecutando el SHA `30ab51b587b21127c3f3419e0ec4c3a8539dfb0a`; las actualizaciones de código deben seguir sus propios gates y verificaciones.


## Anexo — inventario literal de imágenes y directorios antes de la limpieza de archivos

**Procedencia:** `docker images --format` y `find /home/alan -maxdepth 2 -type d` que el operador compartió después del `docker rm`. Son imágenes y directorios **todavía existentes en ese momento**; esta lista no autoriza su eliminación, no demuestra exclusividad de sus capas Docker y no incluye bases de datos no montadas.

### Etiquetas Docker observadas (32)

```text
talaeats-candidate:d584e2dcad91c46b2dfa2834343d5f7562486bca | 283MB
talaeats-rollback/worker:v1.6.4-hf1-e22e4d5 | 280MB
talaeats-v3-worker:latest | 280MB
talaeats-v3-backend:latest | 280MB
talaeats-rollback/backend:v1.6.4-hf1-e22e4d5 | 280MB
talaeats-v3-worker:pre-v164-connect-20261013-023000-672569 | 280MB
talaeats-v3-backend:pre-v164-connect-20261013-023000-672569 | 280MB
talaeats-v3-worker:pre-v163-hf4-20261013-003054-314567 | 282MB
talaeats-v3-backend:pre-v163-hf4-20261013-003054-314567 | 282MB
talaeats-v3-worker:pre-v162-driverpay-20261012-032013-761530 | 281MB
talaeats-v3-backend:pre-v162-driverpay-20261012-032013-761530 | 281MB
talaeats-admin:web-v1.5.2 | 62.6MB
talaeats-admin:rollback-pre-v152-20261011-192508 | 62.6MB
talaeats-admin:web-v1.5.1 | 62.6MB
talaeats-admin-admin:latest | 62.6MB
talaeats-admin:rollback-20261011-144752 | 62.6MB
talaeats-v3-worker:pre-v161-hotfix1-20261011-224239-4126884 | 280MB
talaeats-v3-backend:pre-v161-hotfix1-20261011-224239-4126884 | 280MB
talaeats-v3-frontend:latest | 63.4MB
talaeats-v3-frontend:before-luxe-v4-20260915-023637 | 63.4MB
talaeats-v3-frontend:before-luxe-v3-20260915-022436 | 63.4MB
talaeats-v3-worker:respaldo-20261009-003817 | 269MB
talaeats-v3-worker:rollback-20261009-000250 | 269MB
talaeats-v3-backend:respaldo-20261009-003817 | 269MB
talaeats-v3-backend:rollback-20261009-000250 | 269MB
talaeats-v3-frontend:before-reference-ui-20260915-015409 | 62.9MB
talaeats-v3-frontend:before-reference-ui-v2-20260915-015735 | 62.9MB
talaeats-v3-frontend:v10-rollback-20260913-001034 | 62.7MB
talaeats-v3-frontend:v31-safe-20260913-000546 | 62.7MB
talaeats-v3-backend:v10-rollback-20260913-001034 | 222MB
talaeats-v3-backend:v31-safe-20260913-000546 | 222MB
talaeats-v3-worker:v31-safe-20260913-000546 | 222MB
```

No sumar estos tamaños para inferir espacio liberable: distintas etiquetas pueden compartir IDs y capas, o estar referenciadas por otro contenedor.

### Carpetas reportadas (búsqueda con profundidad máxima 2; no exhaustiva)

```text
/home/alan/TalaEats-V11-LUXE-V3-PATCH-v1
/home/alan/talaeats-green-20261018
/home/alan/TalaEats-V11-LUXE-V4-PATCH-v1
/home/alan/.ssh/talaeats-ci
/home/alan/talaeats-releases
/home/alan/talaeats-releases/TalaEats-Web-v1.6.4-CONNECT-SELF-SERVICE-HF1-LIVE
/home/alan/talaeats-releases/TalaEats-Web-v1.6.0-HOTFIX1-LIVE
/home/alan/talaeats-releases/TalaEats-Web-v1.6.1-CATALOG-MEDIA-HOTFIX1-LIVE
/home/alan/talaeats-releases/TalaEats-Web-v1.6.3-RETIROS-LOCATION-HF4-LIVE
/home/alan/talaeats-releases/TalaEats-Web-v1.6.2-FAIR-PRICING-DRIVER-PAY-LIVE
/home/alan/talaeats-releases/TalaEats-Backend-v1.6.0-STABILITY-SECURITY-HARDENED-HOTFIX1
/home/alan/talaeats-releases/TalaEats-Backend-v1.6.0-STABILITY-SECURITY-HARDENED-FULL
/home/alan/TalaEats-V11-REFERENCE-UI-PATCH-v2
/home/alan/talaeats-admin-releases
/home/alan/talaeats-admin-releases/TalaEats-ADMIN-v1.4.1-KALI-WEB-SWAP
/home/alan/talaeats-v3
/home/alan/talaeats-v3/TalaEats-Web-v3-PRODUCTION
/home/alan/talaeats-node-stage-prep
/home/alan/TalaEats-V11-REFERENCE-UI-PATCH-v1
/home/alan/talaeats-backups
/home/alan/talaeats-v31
/home/alan/talaeats-legacy-backups
/home/alan/TalaEats-ADMIN-v1.5.1-QUALITY-HARDENING
/home/alan/TalaEats-ADMIN-v1.5.2-OPERATIONS-READY
```

**Exclusiones obligatorias de limpieza:** no borrar `/home/alan/talaeats-legacy-backups`, los volúmenes de PG16/media, directorios de credenciales SSH, la instalación Node activa, ni ningún recurso de otro proyecto. Evaluar todas las referencias antes de retirar archivos bajo `/home/alan/talaeats-releases`, `talaeats-backups` o `talaeats-admin-*`.
