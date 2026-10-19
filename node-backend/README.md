# TALA EATS · Node.js 24 + Express + Prisma 7 + PM2 (staging)

**Versión inicial v0.1.0. NO ES un backend de producción ni reemplaza todavía el API Python.**

Nuevo stack: Node.js 24 LTS, Express/TypeScript, PM2, PostgreSQL 15 **nativo**, Redis **nativo** + BullMQ, Prisma 7, Stripe SDK y Stripe Connect Express (fase futura). Código aislado en `node-backend/`.

## Alcance implementado

- `GET /api/v1/health`: proceso vivo, no garantiza DB lista.
- `GET /api/v1/ready`: consulta PostgreSQL y Redis dedicados a staging.
- `POST /api/v1/webhooks/stripe`: firma del cuerpo crudo y veto de eventos LIVE; sólo evento de test a DB y cola BullMQ. Sin operaciones financieras.
- API/worker PM2 independientes, límites de memoria y configuración local.
- Modelos preliminares para eventos Stripe, cuentas Connect y retiros no activos.

**Pendiente:** autenticación, usuarios, comercios, catálogo, pedidos, despacho, perfiles, Connect onboarding, cobros, retiros, conciliación, ledger inmutable y migración de datos. Las apps Flutter y Admin continúan dependiendo de sus contratos actuales.

## Pasos de preparación Kali

1. Leer `docs/KALI-NATIVE-STAGING-RUNBOOK.md`; no ejecutar comandos sobre Docker V3/GREEN.
2. Ejecutar `bash node-backend/scripts/kali-native-preflight.sh` desde la raíz del repositorio.
3. Aprovisionar Node 24, PostgreSQL 15 nativo en `127.0.0.1:15435`, Redis nativo en `127.0.0.1:16379`, con credenciales **nuevas**.
4. Mantener variables fuera de repo en `~/.config/talaeats-node-staging.env`, modo 0600.
5. Dentro de `node-backend/`: instalar deps, generar Prisma 7, validar, compilar y pasar tests.
6. No ejecutar migraciones hasta generar/revisar migración inicial y constatar DB staging vacía.
7. Ejecutar `bash scripts/kali-staging-deploy.sh --preflight` antes de una eventual aplicación explícitamente aprobada.

**CI:** GitHub Actions Node24 valida instalación de dependencias, Prisma, TypeScript y pruebas. No desplegar hasta que exista lockfile versionado y migración DB revisada.

## Frontera de seguridad

No sudo/Docker socket/Cloudflare/Caddy, Stripe LIVE, bancos, finanzas ni puertos productivos. No copiar `.env.production`. La PR #79 corresponde a un agente FastAPI/Python; permanece DRAFT y no se adapta automáticamente a Node. Este repositorio no tiene aún un backend compatible con las apps móviles existentes.

Stripe Connect Express se refiere al tipo de cuenta de comerciantes, no al framework HTTP. Los retiros reales requieren ledger, reconciliación, idempotencia y revisión manual antes de habilitar reintentos.
