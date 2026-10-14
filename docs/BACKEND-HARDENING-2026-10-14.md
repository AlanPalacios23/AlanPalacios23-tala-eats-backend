# TALA EATS — Backend hardening, QA y cambios seguros

> Rama `hardening/backend-quality-2026-10` derivada de la integración de Finance V2 + seguridad. **No es producción.** No autorizada para merge/deploy a Kali ni Stripe LIVE.

## Propósito y alcance

El backend usa FastAPI, Python 3.13, SQLAlchemy, PostgreSQL 16, Redis 8, Alembic y Stripe/Mercado Pago. La auditoría aborda API, validaciones, transacciones, autenticación, seguridad HTTP, idempotencia, observabilidad, worker, modelos financieros, pruebas y documentación. Se documentan riesgos residuales; **ninguna suite de pruebas garantiza ausencia absoluta de errores**.

## Correcciones de idempotencia y HTTP

1. Se excluye completamente `/api/v1/auth/*` de la caché Redis de respuestas: el contenido puede llevar tokens de acceso, pruebas de dispositivo o cookies de sesión. No almacenar ni reproducir ese contenido bajo una clave controlada por cliente e IP compartida. Los handlers de autenticación siguen haciendo todas sus validaciones.
2. Webhooks firmados mantienen su propia deduplicación verificable por evento y proveedor, sin caché HTTP genérica.
3. Solicitudes mayores a 2 MiB evitan una firma insuficiente basada solo en `Content-Length`; se delega la idempotencia a restricciones de dominio y claves del proveedor. Solicitudes pequeñas siguen vinculando clave, identidad, método, ruta, query y cuerpo completo. No es una promesa de idempotencia automática para cada endpoint.
4. Bloqueo Redis ahora usa token aleatorio y liberación atómica compare-and-delete, en lugar de `DEL` ciego: una solicitud lenta no puede liberar el candado tomado por otra tras expirar el TTL.
5. Respuestas con `Set-Cookie` o `Cache-Control: no-store/private` quedan fuera de la caché. Se conserva la funcionalidad original de checkout y sus constraints de BD.
6. Content-Length negativo recibe HTTP 400.

## Invariantes y decisiones financieras

- Finance V2 continúa **desactivado por defecto** y sin banco/PSP comprobado. Una billetera es una proyección de obligaciones, **no efectivo disponible**.
- Eventos entregados, en tránsito, cancelados y reembolsados deben reconciliarse con ledger y banco/PSP; no marcar `paid` a base de capturas. Stripe LIVE y retiros siguen fuera de las pruebas.
- Política tarifaria fair pricing no se altera. No se actualizan migraciones de bases productivas sin revisión de head y respaldo comprobado.

## Auditoría: áreas y estado

| Área | Estado en esta ronda | Pendientes reales |
|---|---|---|
| HTTP autenticación e idempotencia | Correcciones específicas + regresiones | Concurrencia distribuida en Redis real y reintentos después de fallos de red |
| Dinero/Finance V2 | 242 pruebas previas en integración, feature OFF | Conciliación PSP↔banco↔ledger, reembolsos parciales, bloqueo de retiros, auditoría fiscal |
| PostgreSQL/Redis/Alembic | Gate aislado existente | Stress real, deadlocks, múltiples workers y backup/restore |
| Cifrado y dependencias | PyJWT 2.15.1 y cryptography 50.x del PR integrado | Política de actualización continua, verificación de versiones del servidor |
| Observabilidad | Health/ready + métricas existentes | SLO por operación, pruebas de incidentes, disponibilidad real de worker |
| API, roles y webhooks | QA de regresión existente | Pentest autorizado, SSRF/proxies, límites externos, replay de webhooks |
| Documentación y release | Checklist y riesgos | Comparar commit/digest con backend activo en Kali |

## Comandos y gates sin producción

```bash
cd backend
python -m compileall -q app migrations tests
python -m pytest -q
python -m alembic heads
```

También ejecutar los workflows GitHub Actions para PostgreSQL/Redis, Docker offline, bandit/pip-audit y regresiones de seguridad. No confundir pruebas en SQLite con concurrencia PostgreSQL real ni staging con despliegue productivo.

## Protocolo de despliegue

1. PR en borrador → pruebas PASS, código revisado, no ejecutar automáticamente pagos/cobros.
2. Validación de integridad, comparación del SHA e imagen productiva, respaldo PostgreSQL y medios verificado **fuera del servidor productivo**.
3. Staging: Android Usuarios/Restaurante/Repartidor, API E2E, Stripe TEST/MP sandbox, pagos cash sin dinero real, rollback.
4. Confirmación expresa del propietario para cualquier despliegue Kali, migración o cambio en Stripe LIVE; preservar configuración y secretos fuera de GitHub.
