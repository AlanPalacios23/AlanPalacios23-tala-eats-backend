# Tala Eats — Candidato Node.js + PM2 directo en Kali (20-oct-2026)

> **AVISO 21/22-oct-2026 — documento histórico.** Desde que se redactó este plan, el operador confirmó Node RC6 por PM2 y su publicación por Cloudflare (`https://talaeats.alan-palacios-dev.com/api/v1`) y eliminó los seis contenedores Docker Python `talaeats-v3`, preservando sus respaldos y volúmenes. **La URL responde desde staging** (`productionReady=false`, `financialWrites=false`): no demuestra paridad funcional, migración de datos ni aptitud para uso comercial. Ver [bitácora operativa RC6](KALI-NODE-RC6-PUBLIC-API-AND-LEGACY-RETIREMENT-20261022.md) antes de usar instrucciones de este plan.\n\n## Decisión: una sola arquitectura de despliegue

- GitHub guarda el código, aporta versiones y permite las pruebas técnicas existentes. **No es un sistema de despliegue**.
- Kali ejecuta directamente **Node.js 24, Express/TypeScript, Prisma 7, PM2 (API y worker)**, con **PostgreSQL 15 y Redis 8 NATIVOS** en el usuario restringido `tala-node-stage`.
- **Sin nuevos GitHub Actions de despliegue, SSH, Tailscale, VPN, agentes, Docker ni otros orquestadores** para esta versión.
- Producción Python, Docker V3/GREEN, Caddy/Cloudflared, bases de datos LIVE y Stripe LIVE permanecen intactos.
- Hay evidencia del 19-oct de la primera API Node/PM2 en Kali; la actualización a esta rama **NO está atestada en el host**.

## Qué se verificó y qué NO

| Función | Estado verificable |
|---|---|
| Node24/Express/Prisma7, Postgres15/Redis8 efímeros | GitHub CI y E2E candidatos |
| 249 coincidencias de firmas HTTP y 3 rutas Mercado Pago retiradas | Estructural, **no significa funcionalmente equivalente** |
| Cuenta, roles, pickup cash sintético, inventario, order/outbox, owner/driver | CI con datos falsos, no Flutter LIVE |
| Tarifa pickup v1.6.2: 15% comisión, 7% cliente con **tope $25** | Feature flag opcional y CI aislado; rechaza defaults alterados |
| Checkout delivery y pagos Stripe reales | **NO-GO**; bloqueados deliberadamente |
| Stripe webhook recibido, firmado y registrado en staging | No confirma conciliación real de cargos, reversos ni retiros |
| FCM/WebSocket/publicación de outbox | No certificados en runtime |
| Migración de base Python (PostgreSQL16) a Node (PostgreSQL15) | **No implementada/validada**; nunca copiar LIVE por defecto |
| Kali staging con este SHA + apps Flutter + ADMIN | **Pendiente de validación local** |
| Publicar Node en dominio público | **NO-GO** hasta cubrir contratos y datos reales |

**Diferencia financiera fundamental:** Python v1.6.2 permite tarifa de servicio de 7% con tope MXN $25 y calcula envíos escalonados. Node **sólo** soporta los valores por defecto del checkout cash+pickup. No enviar un pedido delivery al handler pickup ni fingir que ya existe facturación Stripe. La bandera `COMMERCIAL_PRICING_V162_ENABLED=true` se habilita exclusivamente después de verificar pricing, esquema y permisos en staging; sin bandera, checkout v1.5.2 sigue vigente para esa instancia.

## Primera promoción a Kali: OPERACIÓN MANUAL con supervisión, no usar updater rápido

El viejo `talaeats-node-source` se instaló en una etapa temprana. Desde entonces hay **múltiples migraciones Prisma** y no basta reiniciar PM2; un deploy en caliente sin revisar migraciones es peligroso.

1. Conocer estado real de Kali bajo el usuario `tala-node-stage`: `id -un`, puerto loopback 18190, health y ready, PM2 API+worker, systemd nativo, espacio/backup y SHA actual. Usar `kali-stage-j1-predeploy-audit.sh --plan`, sin `--apply`.
2. Hacer backup PostgreSQL **staging** exclusivo `kali-stage-backup.py --plan` y luego con autorización `--apply`. Ensayar restauración aislada `kali-stage-test-restore.py` en su socket temporal (no sobre base en uso) y respaldar media de staging.
3. Preparar un checkout independiente de esta rama por **SHA completo aprobado**, ejecutar `npm ci`, `node --env-file=<STAGE_ENV_PRIVADO> ... prisma generate/validate`, `npm run build`, `npm test`. **No modificar el directorio de PM2 en ejecución**.
4. Revisar SQL de `prisma/migrations` y el estado de `prisma migrate status`. Aplicar migraciones **sólo** a la DB PostgreSQL15 `tala_node_stage` ya identificada y respaldada, usando `kali-stage-migrate.sh --preflight` y aprobación explícita separada. **Nunca ejecutar `prisma db push` ni `migrate reset`**.
5. Reapuntar **sólo API y worker PM2 de staging** al release compilado en directorio independiente, con rollback al anterior si el readiness real no pasa. Mantener el proceso bajo el usuario stage sin sudo ni Docker socket. Reiniciar la API y el worker de manera controlada, no modificar systemd global.
6. Validar `/api/v1/health` y `/api/v1/ready` (HTTP 200, `ready=true`, `database=true`, `redis=true`, `financialWrites=false`), roles y permisos, stock/idempotencia, consola ADMIN, driver, media, pedidos y Stripe TEST; inspeccionar `pm2 logs` sanitizados.
7. Registrar SHA desplegado, estado de migraciones, resultado de restauración y un rollback ensayado. **Sin esto no se llama versión desplegada**.

## Actualizaciones normales futuras: un comando manual

Tras completar la primera promoción y quedar la rama staging configurada como rama Git habitual, desde el usuario `tala-node-stage` y el repo actual ejecutar:

```bash
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
cd "$HOME/talaeats-node-source"
bash node-backend/scripts/actualizar.sh --plan

# SOLO SI: rama, SHA, base de datos, respaldos y cambios revisados.
TALA_STAGE_UPDATE_APPROVAL=I_APPROVE_STAGE_PM2_CODE_ONLY \
  bash node-backend/scripts/actualizar.sh --apply
```

El script verifica identidad stage, origen GitHub exacto, rama distinta de `main`, árbol limpio, SHA fast-forward, env 0600, recursos PG15/Redis8 stage y dos procesos PM2 online. **No ejecuta migraciones ni mueve el proxy**. Si cambia cualquier archivo Prisma, se niega y exige el procedimiento manual. Si no cambia Prisma: construye un nuevo `git worktree` en `~/tala-node-releases/<SHA>`, corre pruebas, verifica `prisma migrate status` y cambia únicamente los dos procesos PM2, guardando configuración `pm2 save`. Ante fallo intenta restaurar la carpeta PM2 anterior y comprueba readiness. El cambio tiene una breve interrupción de la API de **staging** y **no se ejecuta automáticamente**.

**Limitaciones conocidas del script:** el rollback de código no revierte esquema ni transacciones y no es recuperación ante desastre. Se requiere mantener backup/restore, y revisar manualmente cualquier modificación de DB y la compatibilidad de los clientes. No usar el script para migrar de Python a Node ni para sustituir la API pública.

## Gate antes del lanzamiento en ~2 semanas

Priorizar: (P0) flujos completos de Usuarios, Restaurante, Repartidor y ADMIN, delivery/dispatch y GPS fresco, checkout Stripe TEST + firma + confirmación idempotente, reconciliación y ledger, comisión y precio mostrados de manera correcta, backup/restore comprobado, auth/MFA, reversos controlados; (P1) FCM/realtime y demás extras críticos de UX. Si un P0 no pasa, usar staging para pruebas y no redirigir tráfico público.

**Con GitHub como único conector activo desde el chat, no se pueden ejecutar comandos del SO de Kali, así que ni CI verde ni este documento equivalen a un despliegue.**
