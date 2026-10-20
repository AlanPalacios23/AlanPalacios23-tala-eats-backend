# TALA EATS / Kali: build separado de la nueva imagen

Fecha: 18 oct 2026. Commit fijo: d584e2dcad91c46b2dfa2834343d5f7562486bca.
Live: Compose talaeats-v3, backend+worker v1.6.4. No hay runner de deploy de GitHub a Kali; el operador ejecuta desde Kali.

## Un solo bloque en Kali (no en PowerShell)

    cd ~/tala-backend-audit
    git fetch origin ops/kali-release-operator-20261018
    git show FETCH_HEAD:scripts/kali_release_operator.py > /tmp/tala-release-operator.py
    python3 /tmp/tala-release-operator.py --prepare

PREPARE valida: commit exacto main en checkout limpio, SHA256 de ambos respaldos cifrados, imagenes previas de rollback, estado PostgreSQL/Redis/Backend/Worker, Alembic sin cambio de esquema, readiness y configuracion de startup que no requiera auto migraciones, proxy wildcard o retiros LIVE activos. Solo entonces construye una imagen distinta de Docker, sin reemplazar ninguna imagen o contenedor que atienda produccion. Verifica usuario sin privilegios e importacion aislada y guarda manifiesto local.

Marcador de exito: KALI_CANDIDATE_PREPARED_PASS.
Si no puede garantizar un preflight: KALI_RELEASE_BLOCKED y NO toca servicios.
No ejecuta despliegue, reinicio, migraciones, SQL, cambios de .env, Cloudflare, Stripe, payout, fotos o base de datos.

## Promocion posterior
El mismo script tiene modo --deploy --confirm SHA, pero rechaza invocacion mientras no exista evidencia real de copia externa SHA256 verificada, ensayo de restauracion a PostgreSQL 16 temporal y revision operativa. Nunca marcar esos controles como pasados sin evidencia. Aun no contamos con resultados de PowerShell de la copia en Windows; la captura muestra archivos en OneDrive pero no el estado de integridad. El ensayo CI sintetico de backup no prueba este respaldo concreto.

Cuando se acredite, --deploy cambiara solo las imagenes de los servicios backend y worker mediante overlay temporal de Compose y --no-deps --no-build; verificara readiness e ID de la nueva imagen; en fallo intentara restaurar imagenes anteriores. Nunca restaura la base de datos ni realiza alembic downgrade: datos financieros nuevos podrian perderse.

La aplicacion actual sigue atendiendo pedidos hasta nueva autorizacion de la promocion.
