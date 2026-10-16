# F2.02 — Atestación Kali API + worker + Alembic (lectura únicamente)

El verificador `scripts/attest_kali_live_readonly.py` compara el checkout GitHub **exacto** con los contenedores activos de Kali. NO ejecuta deploy, rollback, SQL, Compose up/down, cambios de claves, pagos ni migraciones. NO lee `.env`, Docker environment, fotos ni datos personales.

## Preflight aislado

`python3 scripts/attest_kali_live_readonly.py --self-test`

El workflow `kali-release-preflight-ci.yml` ejecuta esta autoprueba SIN red y SIN Docker contra material sintético: coincidencia SHA-256, archivo diferente/faltante/nuevo, Alembic no HEAD o con múltiples HEAD, JSON `/ready` con booleanos falsos/string, versión discordante y URL no autorizada.

Este test **no certifica** que Kali coincida con GitHub.

## Verificación genuina en Kali, cuando corresponda

1. Conservar la aplicación en ejecución. Usar checkout limpio y commit SHA explícito. **No ejecutar `git pull` dentro de ningún contenedor**.
2. Confirmar con responsable autorizado los nombres activos `talaeats-v3-backend-1` y `talaeats-v3-worker-1`; el script bloqueará otros nombres/proyectos/servicios si las etiquetas Compose no coinciden.
3. Ejecutar desde checkout auditado: `python3 scripts/attest_kali_live_readonly.py --repo .`.
4. Guardar **solo** JSON sanitizado: SHA Git, versión, prefijos de hashes de imagen, número de archivos comparados, diferencias de nombres y HEAD de Alembic. No compartir credenciales, rutas privadas, volcados Docker ni datos bancarios.
5. Para considerar aprobado el subcontrol de fuente: `api_worker_source_match=true`, un HEAD de Alembic actual igual al declarado, los dos contenedores activos y la API saludable con versión correcta, `ready/database/redis=true`.
6. Independientemente, cotejar Compose y configuración de worker sin revelar secretos. Una atestación de fuentes no sustituye respaldo off-host, alcance de WAF, KYC o conciliación PSP.

## Criterio de NO-GO

Si cambia un solo hash, falta un archivo, no hay worker, se detecta otro proyecto Compose, la versión no coincide o Alembic diverge: **NO declarar F2.02 completo**. Registrar diferencias para revisión, sin sustituir código ni restaurar DB automáticamente.

F2.02 principal permanece **[ ]** hasta obtener ejecución genuina y cotejo Compose de Kali, asociada a SHA verificado. No usar este resultado para autorizar Stripe LIVE.