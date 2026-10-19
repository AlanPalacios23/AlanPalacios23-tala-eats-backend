# TALA EATS Node J1 — Preparación de despliegue en staging de Kali

**Estado:** runbook preparado, NO desplegado. NO-GO producción. El backend Python V3/GREEN, DNS, Cloudflared, Docker y pagos LIVE no se modifican.

## Distinción importante

La cobertura 252/252 se refiere exclusivamente a método + ruta HTTP. Los endpoints de pago, reembolso, PLUS, retiros, conciliación y algunos otros todavía responden 503 de forma deliberada, por lo que no hay paridad funcional completa ni preparación para lanzamiento. No confundir 100 % de firmas con 100 % de calidad operacional.

## Aislamiento verificado anteriormente en Kali

- Usuario Linux de stage: `tala-node-stage`; repo `/home/tala-node-stage/talaeats-node-source`.
- Node24+PM2 local `127.0.0.1:18190`, PostgreSQL15 local `127.0.0.1:15435`, Redis8 local `127.0.0.1:16379`.
- Node `NODE_ENV=staging`, `HOST=127.0.0.1`, `STRIPE_FINANCIAL_WRITES_ENABLED=false`; credenciales exclusivamente de stage.
- Directorio de media de J1: `TALA_NODE_STAGE_MEDIA_DIR=/home/tala-node-stage/media`, propietario único stage, permisos 0700 y backup propio. NO compartir el media del Python ni depender de `/tmp` para persistencia.

## Paso 1 — Lectura únicamente

Como usuario `tala-node-stage` en la raíz del checkout stage, ejecutar:

```bash
bash node-backend/scripts/kali-stage-j1-predeploy-audit.sh --plan
```

Este script SOLO reporta SHA, identidad, estado de puertos loopback, PM2/systemd, permisos media y estado Git. No ejecuta despliegue, backup, npm, migraciones ni reinicios.

## Pasos pendientes antes de un despliegue stage aprobado

1. Confirmar SHA exacto de CI con ambos eventos PASS (`push` y `pull_request`) y extraer release en directorio nuevo sin modificar la carpeta de procesos en ejecución.
2. Ejecutar `node-backend/scripts/kali-stage-backup.py --plan`, hacer backup autorizado SOLO PostgreSQL15 stage, comprobar `pg_restore --list` y practicar un restore en contenedor/cluster desechable, NO sobre DB con datos vigentes.
3. Respaldar `/home/tala-node-stage/media` stage, comprobar permisos y retención. Preparar variables secretas stage 0600, nunca guardarlas en GitHub.
4. Ejecutar `npm ci`, `prisma generate`, `prisma validate`, `npm run build` y `npm test` en una copia nueva del release, con Node24, Prisma7 y PG15/Redis8 stage clonados.
5. Correr E2E incluyendo los últimos 52 contratos, cobertura 252/252, uploads multipart y pruebas de fallo deliberado de operaciones financieras sin escribir ledger.
6. Verificar compatibilidad JSON real de Flutter Usuarios, Restaurante, Repartidor y ADMIN; probar GPS, checkout delivery, stock y KDS, métodos de pago, media, concurrencia, auditoría, métricas p95 y privacidad.
7. Diseñar un canary exclusivamente en `127.0.0.1:18190`, snapshot previo, regreso a SHA anterior y restore probado. No hay script `--apply` nuevo en J1 y no hay autorización de ejecutarlo.
8. Registrar SHA, migraciones/DDL, pruebas, responsables, horario y plan de vuelta atrás.

## Gates de producción que NO se han superado

- Stripe/MercadoPago con firmas, orden idempotente, callbacks duplicados, conciliación, captura, reembolsos parciales y ledger inmutable.
- Retiros Connect/PSP, reservas inciertas, reintentos seguros, conciliación contable y cash settlements.
- Wallet/PLUS/Gift Cards/Rewards reales sin crédito fantasma.
- Outbox publisher en funcionamiento y WebSocket/realtime, notificaciones FCM/VAPID, ofertas de conductor con GPS reciente.
- Storage durable multi-worker, escáner antivirus, retención, backups+restore, controles de archivos y datos personales.
- JWT cookies Secure/HTTPS, MFA ADMIN externo, RBAC profundo y rate limiting bajo carga.
- SLO p95 medido, RPO/RTO, failover, rollback, prueba de reboot frío e integración end-to-end de apps Android/iOS.

**DECISIÓN: NO-GO LIVE.** La meta de firmas HTTP facilita planificar pruebas; no autoriza modificar producción. Ver checklist maestro #82 y PR #105.
