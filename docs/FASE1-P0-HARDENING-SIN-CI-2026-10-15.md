# TALA EATS · Fase 1 P0 — Código preparado SIN CI (15/oct/2026)

**Rama privada:** `work/fase1-hardening-sin-workflows-20261015` (base `main`), **NO fusionada** y **NO desplegada**. El usuario pidió expresamente **no crear, modificar ni ejecutar workflows** hasta que esté encendida su PC. Todos los commits tienen `[skip ci]`; no se abrió PR porque el evento `pull_request` podría lanzar GitHub-hosted workflows. NO se cambia Kali, Compose, .env, Stripe LIVE, bancos, Redis productivo ni la configuración actual de Cloudflare.

## Cambios preparados, todavía sin pruebas ejecutadas

1. **F1.01 · Idempotencia de checkout** (`backend/app/routes/orders.py`)
   - Para pedidos nuevos con `client_reference`, conserva dentro de un `OrderEvent` la huella **HMAC-SHA256** del `OrderCreate` validado, escrita en **la misma transacción**. Incluye artículos/opciones, importe de propina, regalo, domicilio, ubicación, horario, forma de pago y código de gift card sin almacenar el cuerpo secreto.
   - Repetición exacta de la intención: devuelve pedido existente. Una intención diferente: HTTP **409**, tanto en el lookup inicial como después de `IntegrityError` por concurrencia. La restricción única PostgreSQL `(user_id,client_reference)` continúa como defensa final.
   - Pedidos históricos sin huella se cotejan contra campos persistidos. **Gift-card histórica sin huella**: HTTP 409 (*fail closed*) porque la clave usada originalmente no está persistida.
   - **Riesgo por evaluar**: rotar JWT_SECRET cambia el HMAC de pedidos antiguos; la recuperación deberá hacerse consultando `/orders/mine` sin crear otra orden. Para producción se requiere plan de retención de claves o huella con secreto versionado.
   - Tests sin ejecutar: `backend/tests/test_checkout_reference_integrity_phase1.py` (replay exacto, stock, conflicto de domicilio/artículos/opciones/propina/horario/GPS/gift-code y fallback histórico).
   - Seguimiento: [#18](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/18), [#43](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/43), [PR previa #14](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/pull/14). **La prueba de varios workers y fallos Redis/COMMIT sigue pendiente.**

2. **F1.02 · Arranque seguro** (`backend/entrypoint.sh`)
   - Normaliza `ENVIRONMENT`; en `production` **nunca** ejecuta `alembic upgrade head` ni `python -m app.bootstrap_admin`; configura migración como **comando de mantenimiento separado**.
   - Si `AUTO_MIGRATE_ON_START` se activara en producción, aborta con código 78 en vez de tocar schema. Desarrollo/QA puede conservar migraciones opt-in.
   - `--forwarded-allow-ips` deja de usar `*` y exige allowlist; `*` aborta en producción.
   - Tests POSIX sin ejecutar en Linux: `backend/tests/test_entrypoint_safety_contract.py`; omitidos intencionalmente en Windows.
   - **Bloqueador operacional**: inventariar el Compose real y preparar job de migración aprobado **antes** del primer arranque de esta candidata; de lo contrario el startup se negará a migrar y una DB atrasada causará incompatibilidad.

3. **F1.03 · IP confiable y abuso** (`backend/app/middleware.py`)
   - La identidad del limiter usa `request.client.host` del ASGI scope, y **no** lee crudos `CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP` del cliente.
   - Uvicorn solo debe aceptar X-Forwarded-For si el **peer inmediato** está autorizado por `UVICORN_FORWARDED_ALLOW_IPS`. Operaciones debe asegurar que Caddy/Cloudflare elimine cabeceras falsificadas, revisar ingress y configurar IP/subred del proxy real, **nunca `*`**.
   - **Riesgo de despliegue**: el default `127.0.0.1` puede agrupar a todos los usuarios detrás de Caddy en un bucket; validar la red exacta Docker antes de promover.
   - Tests in-memory sin ejecutar: `backend/tests/test_proxy_rate_identity_phase1.py`. El HTTP **403** externo de [#21](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/21) sigue sin resolver y no se atribuye a este cambio.

4. **F1.04 · Corte de pagos legacy** (`backend/app/routes/operations.py`)
   - Bloquea en **producción** (HTTP 409 antes de escribir DB) cuatro mutaciones legacy: generar payouts manuales, marcarlos `paid`, generar cortes de efectivo y marcarlos `settled` sin comprobación financiera. Los endpoints de **lectura** permanecen.
   - **Advertencia crucial:** esta defensa impediría que ADMIN use esos flujos legacy si se desplegara; primero debe existir un procedimiento de liquidación conciliado/verificable. No habilita otros payouts ni Stripe LIVE.
   - Tests sin ejecutar: `backend/tests/test_legacy_finance_production_block_phase1.py`; revisar con [PR candidata #29](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/pull/29) para evitar duplicar o abrir rutas alternativas.
   
## Gate cuando la PC esté disponible (NO ejecutar hoy)

- [ ] Revisar diff y política de endpoint/gift-card; coordinar cierre o absorción segura de PR #14.
- [ ] `python -m pytest -q backend/tests/test_checkout_reference_integrity_phase1.py backend/tests/test_proxy_rate_identity_phase1.py backend/tests/test_legacy_finance_production_block_phase1.py` en entorno aislado con dependencias, ejecutado desde la raíz con PYTHONPATH correcto.
- [ ] Ejecutar los tests POSIX `test_entrypoint_safety_contract.py` en laboratorio **Linux**, no marcarlos PASS si solo se usa Windows.
- [ ] Suite general Python 3.13, análisis de secretos, pip-audit, Alembic + PostgreSQL16 + Redis8, Docker build y regresiones financieras NO-GO **sobre el SHA de esta rama**.
- [ ] Ensayo de cabeceras spoofing, múltiples workers, red Caddy/Cloudflare y backup + migraciones en Compose de laboratorio, sin consultar fondos reales.
- [ ] Solo con gates PASS crear PR para revisión y decidir su integración a `main`. **No fusionar** ni marcar las cuatro tareas completas antes de la evidencia.

**Resultado actual: CÓDIGO PREPARADO / QA PENDIENTE / PRODUCCIÓN NO AUTORIZADA.**
