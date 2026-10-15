# TALA EATS — Puerta de pagos reales (preproducción)

Este documento no autoriza ni ejecuta cobros, transferencias, retiros o depósitos. Requiere verificación de proveedor, datos bancarios, operaciones y revisión legal antes de permitir movimiento real de dinero.

## Auditoría sin secretos

Ejecutar desde backend: python -m app.payment_go_live_gate

Siempre sale con estado de bloqueo (exit 2), incluso cuando las variables de Stripe parecen completas. No imprime claves ni identificadores bancarios. Una configuración correcta no prueba capacidad LIVE, KYC ni conciliación.

## Activación por etapas, nunca simultánea

1. Confirmar entidad legal cobradora, cuenta Stripe LIVE exacta, cuenta bancaria verificada y cuentas Connect de restaurantes/repartidores. No inferir la titularidad de una cuenta conectada por su nombre.
2. En staging usar Stripe TEST y Mercado Pago sandbox. Probar compras, webhooks firmados, cierre de pedidos, propinas, comisión 15 %, tarifa de servicio 7 % cap $25, distancia, reembolsos, contracargos, errores de red, reintentos y claves de idempotencia.
3. Tras autorización expresa, realizar una compra piloto LIVE de importe exacto, mínimo y acordado, y verificar que el PSP, la cuenta bancaria y el libro contable reconcilien. Nunca crear cargos o reembolsos por cuenta propia sin autorización del titular.
4. Conectar transferencias Stripe Connect para beneficiarios KYC aprobados y destinos bancarios únicos; comprobar remanente y que no se pague dos veces por batch legacy y transferencias Connect.
5. Activar retiros mediante aprobaciones de cuenta y banco, MFA/TOTP, límites y conciliación probada. Mantener WITHDRAWALS_EXECUTION_ENABLED y WITHDRAWALS_LIVE_ENABLED apagados hasta autorización individual.
6. Efectivo: Finance V2 es contabilidad sombra. Todavía faltan recuperación de billetes, conciliación, netting de fondos verificados, consentimiento y controles de pérdida. No habilitar cobro automático cash ni fingir que los saldos negativos son depósitos bancarios.

## Endpoints legacy incompatibles

Esta rama bloquea con HTTP 409 en producción: POST /api/v1/operations/admin/payouts/run, POST /api/v1/operations/admin/payouts/{id}/mark-paid, POST /api/v1/operations/admin/cash-settlements/run y PATCH /api/v1/operations/admin/cash-settlements/{id}. No reemplazar por registros manuales de 'paid' sin evidencia bancaria. Este bloqueo cambia el contrato de producción y necesita revisión de uso antes del despliegue.

## Migraciones de PostgreSQL: gate de arranque productivo

En la release candidata, el `backend/entrypoint.sh` **nunca ejecuta `alembic upgrade head` automáticamente cuando `ENVIRONMENT=production`**, aunque un `.env` heredado declare `AUTO_MIGRATE_ON_START=true` (o `1`, `yes`, `on`, sin importar mayúsculas/espacios). En ese caso el arranque se **rechaza con exit 78**: no se migra la base y tampoco se inicia una API con esquema inesperado. El operador debe limpiar esa configuración antes del rollout; verificarla durante el preflight. En QA/desarrollo, el comportamiento de migración local sigue igual.

Únicamente un **job de mantenimiento separado y aprobado** puede invocar explícitamente `alembic upgrade head`, después de cotejar versiones, validar backups PostgreSQL y media, ensayar restauración/migraciones con PostgreSQL 16 de staging y autorizar la ventana. La forma `entrypoint.sh alembic upgrade head` ejecuta el comando explícito sin lanzar Uvicorn; este PR **no lo ejecuta ni habilita desde GitHub Actions**.

No desplegar el nuevo entrypoint a Kali hasta verificar compatibilidad del `.env` productivo sin revelar secretos, validar el plan de rollback y completar la autorización manual del release. Relacionado: issue #17.

## Evidencia GO/NO-GO

Pruebas PASS, respaldo y restauración comprobados, revisión SAT/CFDI según actividad y régimen, cuenta bancaria verificada, receivables contra extractos y proveedor, KYC de cada beneficiario, conciliación por pedido, reversos y límites de fraude. /ready=true solo prueba infraestructura, no cuentas monetarias.

Ninguna modificación en esta rama aplica cambios a Kali, Stripe LIVE o Mercado Pago. El despliegue, migraciones y activaciones requieren autorización separada y validación de la versión realmente desplegada.
## CI de release candidato

El PR #29 apunta a main únicamente para validar en conjunto backend, seguridad y finanzas. Permanece DRAFT; que las suites pasen no constituye autorización para desplegar, migrar ni habilitar cobros LIVE.
