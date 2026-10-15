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

## Identificación de clientes y proxy inverso
- `TRUST_PROXY_HEADERS=true` **solo** confía en IPs de proxy cuyo IP *de conexión* pertenezca a `TRUSTED_PROXY_CIDRS` (lista de redes CIDR). Por defecto se confía únicamente en loopback; no usar `0.0.0.0/0` ni redes arbitrariamente amplias.
- En el despliegue Docker/Caddy/Cloudflare, identificar la dirección del **último salto entre el proxy y Uvicorn**, configurar su CIDR concreto y hacer que ese proxy **reemplace** las cabeceras CF-Connecting-IP/X-Forwarded-For enviadas por clientes. Probar el límite de login desde dos IP distintas y conexión directa.
- Si el proxy real no está en la lista, la aplicación tomará la IP del proxy, por seguridad; esto puede agrupar usuarios bajo la misma cuota hasta configurar el CIDR correcto. Verificar antes de desplegar.
- Los valores incorrectos de `X-Request-ID` son sustituidos por UUID; los IDs válidos se preservan sin caracteres de control.

## Worker Redis — propiedad exclusiva del ciclo
- `_refresh_cycle_lock` ahora devuelve verdadero solamente si Redis confirma que **el mismo token aún posee el lease** y ha renovado su TTL. Si el candado caduca, cambia de dueño, desaparece Redis o falla su renovación, `run_once` detiene **las tareas restantes** del ciclo, evitando disparar nuevos trabajos después de perder exclusividad.
- Esto no convierte en atómica una tarea externa que ya comenzó; siguen siendo necesarios idempotencia, outbox y locks transaccionales en cada operación crítica, especialmente pago/reconciliación. Los jobs completos se prueban en staging con dos workers concurrentes.

## Salud operativa sin falsos positivos
- `GET /api/v1/ready` sigue comprobando **PostgreSQL y Redis** sin cambiar el contrato HTTP 200/503 utilizado por los probes de Caddy/Docker. Devuelve además `worker_heartbeat_detected` y `finance_v2_shadow_enabled` para diagnóstico.
- `GET /api/v1/health` muestra la capacidad `finance_v2.mode = disabled|shadow_only`, `bank_reconciliation_verified=false` y `automatic_settlements_enabled=false`. `core_checkout` es `degraded` cuando DB o Redis fallan, en lugar de reportar `ready` estático.
- **No interpretar** `ready=true` como prueba de worker saludable, transacciones bancarias, cobros automáticos ni reconciliación completa. Escalar incidentes cuando el worker heartbeat desaparezca, aunque el API siga respondiendo.
- `Settings.validate_production` ahora rechaza CIDRs inválidos o subredes de confianza universales (0.0.0.0/0 o ::/0) antes del arranque; jamás incluir secretos productivos en pruebas.

## Arranque seguro de API y migraciones
- `backend/entrypoint.sh` **no ejecuta Alembic en cada arranque productivo** por defecto. `AUTO_MIGRATE_ON_START=false` si `ENVIRONMENT=production`; desarrollo/CI conserva comportamiento anterior (`true`). Los cambios de esquema requieren una fase de migración independiente después de respaldar PostgreSQL y confirmar la revisión Alembic y la compatibilidad del código ejecutado.
- Uvicorn ya **no acepta** `--forwarded-allow-ips="*"`: usa `UVICORN_FORWARDED_ALLOW_IPS=127.0.0.1` por defecto. Configurar IPs exactas del proxy Caddy/Cloudflare (último salto de red) antes de desplegar, **junto con** `TRUSTED_PROXY_CIDRS` de la aplicación. Ambos controles deben coincidir con la topología real y ninguna lista debe admitir Internet completo.
- `app.bootstrap_admin` conserva su comportamiento previo por compatibilidad: revisar antes del siguiente release qué campos y roles se crean por arranque, MFA y bootstrap idempotente. Si faltan migraciones productivas, el arranque debe fallar de forma visible en lugar de intentar cambiarlas silenciosamente.
- Verificar que la app reciba IP correcta de usuarios reales detrás de Caddy y que una conexión directa con cabeceras falsificadas no pueda saltarse el rate limit.

## Corrección de la regresión del middleware
- Se admite tanto `Response.body` (respuesta directa) como `Response.body_iterator` (respuesta ASGI streaming); evita el AttributeError para JSONResponse.
- La prueba de login legacy ahora comprueba que nunca se reutilice un token de autenticación desde Redis: una contraseña errónea responde 401, no 409 por idempotencia genérica.

## Seguridad de Google Sign-In y TOTP
- Google SSO ahora valida `sub` no vacío y el estado activo de la cuenta **antes** de cambiar la identidad enlazada o guardar cualquier sesión.
- Si la cuenta tiene 2FA, exige `otp` TOTP válido también al entrar con Google; no se permite omitir el segundo factor seleccionando un login diferente.
- Una cuenta enlazada a un `google_sub` distinto rechaza el re-enlace con HTTP 409. Google SSO normal para clientes que no tienen 2FA sigue admitiendo el contrato de `credential` existente.
- Antes del deploy de esta corrección, coordinar que el frontend de cuentas con 2FA permita capturar el OTP en Google Sign-In; no relajar la verificación en producción.

## Límites de memoria y arranque coherente
- La caché genérica de idempotencia almacena únicamente respuestas JSON con `Content-Length` válido y máximo de 2 MiB. SSE, archivos, respuestas chunked y cuerpos sin tamaño conocido **no se consumen ni acumulan en RAM** desde este middleware. Tales rutas requieren idempotencia del dominio/proveedor.
- El script de arranque normaliza `ENVIRONMENT` igual que Python (espacios y mayúsculas), evitando que `PRODUCTION` o ` production ` activen Alembic en un reinicio. Esto no sustituye la migración controlada fuera del contenedor.

## Bootstrap de administradores: sin elevación automática
- Hallazgo P0: el código anterior ejecutaba `python -m app.bootstrap_admin` en cada arranque y, si `BOOTSTRAP_ADMIN_EMAIL` apuntaba a una cuenta existente de cualquier rol, **la promovía a admin**. No hay evidencia de que esto se haya explotado ni desplegado, pero era inseguro.
- El nuevo `bootstrap_admin` está desactivado por defecto, solo crea una cuenta NUEVA con contraseña fuerte (mínimo 20 caracteres) y nunca eleva, reactiva ni modifica una cuenta existente. Re-ejecutar en un admin activo ya existente es idempotente, sin cambiar contraseña.
- Producción: nunca ejecutar automáticamente bootstrap desde entrypoint, incluso si por error quedó `BOOTSTRAP_ADMIN_ENABLED=true`. Ejecutar excepcionalmente un comando `python -m app.bootstrap_admin` en mantenimiento supervisado, con `BOOTSTRAP_ADMIN_ENABLED=true` y credenciales **protegidas fuera del repositorio**, seguido de configuración TOTP. Retirar las variables al terminar y auditar altas con control dual.
