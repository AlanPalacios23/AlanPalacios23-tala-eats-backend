# TALA EATS · Node.js PREPROD RC1 · 20 octubre 2026

**Estado contractual:** candidato para el **próximo despliegue aislado a staging Kali**, **NO autorizado para producción comercial**. No renombrar un servidor staging ni abrir un dominio productivo como sustituto de pruebas. Python en producción continúa intacto.

## Línea base, alcance y controles
- Basado en rama stage de código `feat/node-kali-direct-pm2-release-20261020` SHA `64ccabc0d71bbf18e2c43122804b4feae30ad0c0`.
- PostgreSQL 15 y Redis 8 aislados en loopback, Node 24, Express 5, Prisma 7, PM2 API y worker independientes.
- Tres apps Flutter pueden apuntar por `--dart-define` al dominio HTTPS de pruebas `https://api-stage-talaeats.alan-palacios-dev.com/api/v1`.
- Sin Mercado Pago. Stripe sólo TEST, no movimientos financieros; `financialWrites=false` siempre.
- No se altera Python productivo, gateway ni Zero Trust.

## Nuevo gate de release
- `npm run release:stage:check`: verifica controles básicos del código de staging, sin credenciales ni tráfico externo. PASS no demuestra paridad.
- `npm run release:production:check`: **debe fallar** con `PRODUCTION_NO_GO`; muestra explícitamente impedimentos de producción. No existe flag para obviarlo.
- `npm run smoke:stage`: GET estrictamente **solo** a localhost staging o HTTPS del host stage. Verifica `health.production=false`, `ready.productionReady=false`, DB+Redis, worker heartbeat, Stripe apagado, mercados TALA-JAL/AMECA-JAL y 422 para filtros malformados.
- `/api/v1/ready`: reporta `workerOnline` separado del estado DB/Redis y `productionReady=false`. No cambia los contratos anteriores de `ready`, `database`, `redis`, `financialWrites`.
- Actualizador manual de Kali `scripts/actualizar.sh`: el rollback cubre también el nuevo smoke. Sin modificaciones de schema.

## Puertas bloqueantes de producción comercial (todos deben pasar)
1. **Cobros digitales:** Stripe TEST completo en entorno aislado (crear intent, SCA si aplica, webhook válido/repetido/tardío, estado de pedido, ledger y reconciliación), luego revisión LIVE; refund/chargeback/settlement. Nunca introducir `sk_live` en esta rama stage.
2. **Pedidos y entrega:** flujo real Usuarios → Restaurante/KDS → Driver/propios → comprobante → finalización/cancelación/reversa de stock; no fixture `stage_driver_fixture`. Validar comisión restaurante 15%, tarifa servicio 7%, propina 0%, envío base $39 y pago estimado driver $32 para delivery, con reglas según distancia/servicio aplicables.
3. **Identidad:** recuperación de contraseña **entregada de verdad** mediante remitente verificado, enlace Android comprobado en teléfono, MFA administrativo TOTP y protección de sesiones.
4. **ADMIN y soporte:** terminar revisión del PR #109 con migración aditiva y rollback SQL; QA tickets de Usuarios, respuesta visible y archivado lógico seguro. No desplegar migración mediante `actualizar.sh` (se niega expresamente).
5. **Tres aplicaciones:** matriz E2E en dispositivo Android y iOS (cliente, tienda, driver), JSON/códigos/status, fotos, notificaciones, GPS, socket real o fallback, reconciliación y tiempos. Los builds APK anteriores solos no prueban interoperabilidad.
6. **Infraestructura y seguridad:** backup de PG+media verificable, restauración a host aislado, alerta y retención, permisos por rol/objeto, tasa por IP/usuario, revisión de dependencias, TLS/túnel y autorización de cambios. Evitar PII o cobros reales en staging público.
7. **Corte productivo:** runbook de tráfico/rollback de Python ↔ Node, criterio de rollback y monitoreo de pedidos, disponibilidad y pagos; aprobación explícita después del QA.

## Plan de siguiente despliegue seguro (sólo staging)
1. Confirmar CI del PR en GitHub para Node 24, Prisma, PostgreSQL 15, Redis 8 y los E2E.
2. Guardar fuera de GitHub respaldos **de staging** DB + media `/home/tala-node-stage/media`; respaldar también `/tmp/tala-node-stage-media` si hubo uploads anteriores para que no se pierdan. Confirmar restore de prueba. Proteger tokens y claves env modo 0600.
3. Fusionar PR sólo al branch de staging revisado. Ejecutar `bash node-backend/scripts/actualizar.sh --plan` con usuario `tala-node-stage`. Inspeccionar SHA remoto, actual vs destino, migraciones y PM2.
4. Con aprobación explícita del operador, ejecutar el actualizador `--apply` que instala código nuevo, verifica Prisma **sin migrar**, levanta PM2 y aplica smoke con rollback.
5. Verificar HTTPS desde el dispositivo y ejecutar QA con **cuentas ficticias** de los tres roles. Cualquier fallo deja el corte a LIVE bloqueado.

**STOP inmediato:** migraciones inesperadas, cambios en Python o su PG16, `financialWrites=true`, errores en respaldos/restauración, discrepancia de contratos, clave Stripe LIVE o rutas Admin públicas no protegidas.

## Interpretación de CI
Un `SUCCESS` sólo avala el código y los datos sintéticos de esa ejecución. **No es una autorización para abrir cobros, pasar el dominio productivo a Node o declarar el backend 100% funcional.**
