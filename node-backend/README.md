# TALA EATS · Node.js 24 + Express/TypeScript + Prisma 7 + PM2

> **Release candidate de STAGING en Kali. No sustituye aún Python ni admite pagos reales.**
>
> Guía actual de despliegue directo: [KALI-PM2-DIRECT-RC-2026-10-20.md](docs/KALI-PM2-DIRECT-RC-2026-10-20.md).
> La primera instalación/salto desde v0.1.0 requiere migraciones revisadas y backup, no sólo `pm2 restart`.

## Arquitectura

- API Node.js 24 + Express en `127.0.0.1:18190` con PM2.
- Worker independiente bajo PM2, BullMQ y Redis 8 aislado en `127.0.0.1:16379`.
- Prisma 7 y PostgreSQL 15 nativo en `127.0.0.1:15435` (`tala_node_stage`).
- Un único usuario Linux sin privilegios `tala-node-stage`, secreto fuera del repo en `~/.config/talaeats-node-staging.env`, permiso 0600.
- Solo Stripe TEST, webhooks firmados en staging. `STRIPE_FINANCIAL_WRITES_ENABLED=false`: **ningún cobro, captura, reembolso o retiro LIVE**.

## Cobertura real

Hay 249 coincidencias estructurales de firmas HTTP Python→Node, y tres rutas de Mercado Pago retiradas deliberadamente. **La cifra no es paridad de negocio**: varias rutas responden 503 y faltan pagos Stripe funcionales, delivery completo, reconciliación de dinero, tiempo real/FCM y QA integral de Usuarios, Restaurante, Repartidor y ADMIN.

Flujos cash/pickup de staging cuentan con atomicidad, referencia idempotente, inventario, ledger sintético, KDS y seguridad de roles en pruebas aisladas. Se agregó una bandera opcional `COMMERCIAL_PRICING_V162_ENABLED=true` para la política de pickup v1.6.2 (15% comisión, 7% servicio con tope $25); tarifas personalizadas divergentes se rechazan con 503. Esto NO significa soporte de pedidos de entrega ni Stripe checkout.

## Pruebas del código

Con Node.js 24 y dependencias localmente instaladas:

```bash
cd node-backend
npm ci
npm run generate
npm run db:validate
npm run build
npm test
```

Hay además pruebas E2E PostgreSQL15/Redis8 **sólo** en runners efímeros GitHub, incluyendo webhook TEST, usuarios, stock, idempotencia, finanzas sintéticas, API, worker y política v1.6.2. Nunca ejecutar los E2E que llevan `CI_ONLY` sobre Kali.

## Actualización manual después de la primera instalación

```bash
# Como tala-node-stage en el repo staging con su rama Git configurada:
bash node-backend/scripts/actualizar.sh --plan

# Sólo después de revisar y si no hay cambios Prisma:
TALA_STAGE_UPDATE_APPROVAL=I_APPROVE_STAGE_PM2_CODE_ONLY \
  bash node-backend/scripts/actualizar.sh --apply
```

`actualizar.sh` **no instala un agente ni automatización**; crea un release separado por SHA, verifica compilación/tests/readiness, controla dos procesos PM2 y tiene intento de rollback de código. Si hay migraciones, detiene la actualización para revisión manual. No usar este comando para migrar Python→Node o modificar producción.

Para el primer despliegue en Kali: seguir el runbook y comprobar backup/restauración de PG15 staging, migraciones, estado PM2 y compatibilidad de las cuatro interfaces. **No habilitar LIVE sin esos gates.**
