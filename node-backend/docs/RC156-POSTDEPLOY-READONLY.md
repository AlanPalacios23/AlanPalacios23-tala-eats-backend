# RC156 · Cierre de pruebas de despliegue y posdespliegue — Tala Eats

**Estado:** candidata, NO publicada. No activar flags ni conectar tráfico LIVE hasta los gates aplicables.

## Dependencias de integración (NO saltar)
- Backend Node: RC144 (avatar) → RC153 (#209, RBAC soporte) → RC154 (#210, idempotencia/cuotas) → RC155 (#211, matriz de roles) → RC156 (este cambio).
- PWA: RC144–150 → RC151 (#35) → RC152 (#36) → RC153 (#37) → RC154 (#38) → RC155 (#39) → RC156.
- No asumir que cada rama basada en otra ya está fusionada a `main`. Una PR verde contra su rama base NO equivale a un deployment válido.
- Comparar SHA real en servidor Kali, schema Prisma y migraciones antes de integrar. Ningún script de este PR aplica cambios a producción.

## Verificación PREVIA (sin mutaciones)
1. En Kali, identificar la release Node actualmente **activa** y SHA correspondiente, procesos PM2, puertos y túneles Cloudflare. No publicar ni imprimir archivos .env ni token alguno.
2. Revisión de flags: `DRIVER_ORDER_SUPPORT_ENABLED` debe continuar `false`; en PWA `VITE_DRIVER_SUPPORT_ENABLED` debe continuar desactivada en el primer despliegue.
3. Verificar versión del Node, `npm run verify`, `npm test` y migraciones pendientes **solo de lectura**. No utilizar `migrate deploy` durante una inspección.
4. Pruebas E2E en staging separado con PostgreSQL/Redis: driver A asignado / driver B ajeno, reintento simultáneo idéntico con un solo ticket, revocación de asignación, sesión A→B, entrega completa con PIN y conciliación existente. No ejecutar estos POST en LIVE.
5. Respaldar versión previa y ruta exacta del artefacto, base de datos según procedimiento aprobado, PM2 y configuración de reverse proxy; probar rollback sin escribir al entorno de producción.

## Posdespliegue de SOLO LECTURA
Una vez publicado un backend compatible en **stage**, desde una copia confiable del repositorio:
```bash
cd node-backend
node scripts/rc156-postdeploy-readonly.mjs --mode=stage
```
En LIVE, **solo después del despliegue autorizado y con respaldo**:
```bash
cd node-backend
node scripts/rc156-postdeploy-readonly.mjs --mode=live --with-pwas
```
El script hace únicamente GET a hosts fijos: API `health`, `ready`, `support` y `support/capabilities` sin sesión, además de las rutas públicas de las 3 PWAs cuando se solicita. No acepta URLs arbitrarias, no envía credenciales, no sigue redirecciones y **no cambia datos**.

## Criterios estrictos PASS
- `/health` HTTP 200, producción correcta para el modo elegido y versión identificable.
- `/ready` HTTP 200, `ready`, PostgreSQL, Redis y **workerOnline** confirmados; booleano financiero expuesto sin modificar ni inferir permiso de transferencia.
- `GET /platform/support` y `GET /platform/support/capabilities` **SIN SESIÓN** devuelven HTTP 401. Una respuesta 200, 404 o 503 no valida la protección.
- Las tres PWAs públicas devuelven HTML sobre HTTPS y HTTP 200 (no revela si JS compilado y permisos son compatibles; eso se valida en QA).
- Verificar manualmente SHA de la release activa y correspondencia con el build y el rollback: **no existe un endpoint confiable que exponga SHA**. Un script PASS no permite saltar esta verificación.

## GATE pendiente específico de soporte
En staging, usando cuentas controladas y un pedido de prueba legítimo:
1. Con flag apagado, POST de driver asignado con y sin `order_id` → 403.
2. Con flag habilitado en staging, driver A asignado → 201 con su ID y `order_id`; driver B para esa orden → 404, sin filtrar datos de comprador.
3. Repetir simultáneamente mismo POST de A → un ticket único, respuesta 201/200 con el mismo ID; cambios de contenido deben recibir ticket nuevo o 429 si agotó cuota.
4. Tras quitar asignación, A deja de poder crear nuevo ticket vinculado.
5. Sesión PWA A→B no conserva PIN, efectivo, ofertas, wallet, GPS ni soporte.
6. ADMIN usa MFA real y el canal de emergencia no promete respuesta 24/7.
7. Verificar contabilidad, transfers/Stripe y liquidaciones por separado: soporte nunca autoriza dinero.

## Si hay FAIL
Detener promoción y **no activar nuevos flags**. Conservar artefactos y diagnósticos sin datos personales, aplicar rollback al artefacto anterior confirmado siguiendo el procedimiento on-prem aprobado y repetir los GET. Una regresión en entrega o acceso a datos privados es un bloqueo de publicación, aunque el endpoint `/health` funcione.

**Limitación:** esta guía y sus checks no ejecutan despliegue, no crean pedidos y no prueban al proveedor de mapas/Push. Son gates de validación posteriores a un despliegue aprobado.
