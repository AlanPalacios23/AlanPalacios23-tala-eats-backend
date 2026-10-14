# TALA EATS · Backend production readiness — 13 oct 2026 (México)

**Estado: NO APTO TODAVÍA PARA DESPLEGAR CAMBIOS A KALI.**
Este repositorio contiene un **snapshot de código PREDEPLOY v1.6.4**, sin comparación de hashes con la release actualmente activa en Kali. El backend live no fue modificado en esta auditoría.

## Gates ejecutados y evidencias

| Gate | Main / baseline | Rama candidata |
|---|---|---|
| FastAPI pytest con SQLite sintético | 211 PASS en [#16](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38497913831) | PR #14: 214 PASS (incluye 3 regresiones idempotencia); PR #15: 213 PASS (incluye 2 regresiones JWT) |
| PostgreSQL 16, Redis 8, Alembic y pedidos sin proveedor | [DB #3](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38501366156) PASS | PR #14 y #15 PASS |
| Construcción real de imagen Docker / usuario no root / importación offline | [Docker #1](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38502114744) PASS | PR #15 debe certificar su propia imagen con dependencias actualizadas |
| SAST Bandit high/high | Sin hallazgos | PR #15 PASS |
| Dependencias pip-audit | **FAIL**: 18 avisos (14 PyJWT 2.13.0; 4 cryptography 46.0.7) [informe](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38501784715) | [PR #15](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/pull/15) con PyJWT 2.15.1 y cryptography 50.0.2: **audit PASS** |
| Verificación exacta de Kali LIVE vs commit | **PENDIENTE** | [#1](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/1) |
| E2E Stripe TEST + webhooks + retiros + múltiples workers | **PENDIENTE** | [#3](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/3) |

## Hallazgos prioritarios

### P0 / seguridad de dependencias
La release candidata declaraba bibliotecas con vulnerabilidades conocidas. La explotación real depende del uso en TALA EATS y las versiones instaladas en el contenedor, que no se han verificado. El PR #15 está **en revisión**, no desplegado, y requiere CI completo e inspección de compatibilidad de librerías.

### P0 / idempotencia en el checkout
Las compras con `Idempotency-Key` idéntico pasaron en PostgreSQL 16 + Redis 8: misma orden, stock reducido una vez, cuerpo distinto → HTTP 409. Sin encabezado, `client_reference` histórico podía reusar silenciosamente un pedido aunque cambiara cantidad/dirección. PR #14 añade validación de equivalencia, actualmente no fusionada.
**Sigue sin probarse**: concurrencia alta, Redis fuera de servicio en mitad del commit, reintento con una nueva referencia de la app, webhooks financieros duplicados/out-of-order y múltiples workers.

### P0 / operación de base de datos
`backend/entrypoint.sh` corre `alembic upgrade head` automáticamente antes de iniciar Uvicorn. Proponer separación: migración controlada antes del rollout, backups verificados (PG + fotos), revisión de esquema, supervisión humana, rollback de imagen y procedimiento forward-fix para migraciones irreversibles. [Seguimiento #17](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/17).

### P0 / trazabilidad del deploy
No confundir `ready=true` con coincidencia de código: contrastar la versión exacta, imagen/digest y fuente efectiva de `talaeats-v3-backend-1` contra GitHub. No cargar config productiva, JWT, Stripe LIVE, SQL dumps ni datos personales en GitHub.

### P1 / robustez del piloto
- QA de PostgreSQL real con sesiones concurrentes, deadlocks, outbox, DLQ, reconciliación y simulación de reinicios de worker.
- QA Stripe **TEST** aislado para cobros, cancelaciones, refunds y transferencias; verificación de firma de webhook y ledger; simulación de balance insuficiente.
- Prueba de restauración de backups, SLO de tiempo de pedido, alertas de API/db/Redis/worker, incident response, rotación de secretos y retención de logs sin datos personales.
- Release manual firmado / control de cambios / rollback / validación de servicios Cloudflare Caddy ADMIN. Todo separado de CI.

## Protocolo seguro

1. Trabajar en PR y exigir PASS de 211+ pruebas, PostgreSQL/Redis, pip-audit y Docker, sin secretos.
2. Copiar release candidata a staging independiente; comparar con contrato de las 3 apps y validar E2E con pagos de prueba.
3. Verificar código efectivo LIVE y restauración sobre respaldo **fuera de producción**.
4. Solo después solicitar aprobación explícita de despliegue en Kali, con backups, revisión de migraciones y seguimiento del release.

**No se realizó deploy, migración o pago LIVE durante este trabajo.**
