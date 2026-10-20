# TALA EATS Backend — GitHub Actions → SSH → Kali

Estado: **PR en revisión, NO activado en producción** (18/oct/2026).
La existencia de GitHub auth en Kali permite Kali → GitHub, pero el flujo inverso
GitHub Actions → Kali requiere SSH accesible desde el runner de GitHub.

## Auto-Deploy
1. Commit de backend/** en main.
2. Cinco CI (QA, PostgreSQL/Redis, finanzas, imagen Docker, seguridad) deben
   terminar SUCCESS para el mismo SHA de un push a main. SHA obsoleto se rechaza.
3. Workflow kali-ssh-auto-deploy.yml conecta únicamente con SSH Ed25519,
   usuario/host restringidos, host-key verificado y Environment de producción.
4. Receiver forzado por authorized_keys admite solo comando probe o deploy
   seguido de SHA hexadecimal de 40 caracteres. No da shell arbitrario.
5. Motor Kali valida aprobación root, backup cifrado, restauración y política
   off-host, migración Alembic actual, flags LIVE seguros, salud de servicios.
6. Crea Git worktree aislado e imagen candidata SHA, preserva imágenes
   backend/worker anteriores y cambia SOLO esos dos contenedores Compose.
   Comprueba ready e intenta rollback de imágenes si falla.
7. No cambia postgres, redis, Caddy, Cloudflared, media, env o Stripe LIVE.
   No ejecuta pagos, alembic upgrade o restauración sobre producción.

## Red y conectividad
GitHub-hosted runners necesitan alcanzar el SSH de Kali. Que WinSCP funcione
en tu LAN NO demuestra acceso desde Actions. Configurar primero túnel SSH
seguro/overlay privado (p.ej. Tailscale o una ruta Cloudflare Access SSH
explícitamente configurada). NO abrir puerto 22 indiscriminadamente.
El workflow creado usa SSH estándar y fallará cerrado si Kali no es alcanzable.

## Aprovisionar llave SSH dedicada, fuera del repositorio
Generar una NUEVA Ed25519 de CD desde tu equipo privado. Solo el archivo
PUBLICO .pub se agrega a Kali. La llave PRIVADA se guarda en un GitHub
Environment protegido, jamás en PR, commits o ChatGPT.

En Kali, después de aprobar esta PR y obtener sus scripts en una copia
revisada, instalar receiver/motor con ownership root:

    sudo install -d -m 0755 /usr/local/libexec
    sudo install -o root -g root -m 0644 scripts/kali_cd_deploy.py /usr/local/libexec/talaeats-cd-deploy.py
    sudo install -o root -g root -m 0755 scripts/kali_cd_ssh_receiver.sh /usr/local/sbin/talaeats-cd-receiver

Añadir una LINEA de clave pública en /home/alan/.ssh/authorized_keys, dejando
intactas las entradas anteriores:

    restrict,command="/usr/local/sbin/talaeats-cd-receiver" ssh-ed25519 TU-CLAVE-PUBLICA talaeats-gha

Permisos: ~/.ssh 0700 y authorized_keys 0600. No instalar una llave privada en
Kali si no es necesario. La cuenta alan tiene acceso Docker equivalente a root:
la restricción forced-command y las reglas de rama/Environment son esenciales.

Verificar la huella SSH del Kali real por canal independiente ANTES de guardar
su linea known_hosts; NO confiar a ciegas en ssh-keyscan.

## GitHub Settings → Environments → talaeats-production
Proteger Environment con revisores obligatorios y rama main. Introducir en
Environment Secrets:
- TALAEATS_KALI_SSH_HOST (host SSH alcanzable desde GitHub Actions)
- TALAEATS_KALI_SSH_PORT (22 o el puerto específico)
- TALAEATS_KALI_SSH_USER (alan)
- TALAEATS_KALI_SSH_PRIVATE_KEY (nueva llave privada para Actions)
- TALAEATS_KALI_SSH_KNOWN_HOSTS (host key verificable, fijada)

Environment Variable TALAEATS_CD_ENABLED: mantener SIN DEFINIR / NO hasta
comprobar recuperación y autorizar producción. No usar llaves de Kali para
Stripe, PostgreSQL ni claves SSH personales en GitHub Actions.

## Prueba de conexión, sin deploy
Después de fusionar y configurar el Environment, Actions → workflow
TALA EATS | Kali SSH Auto-Deploy (gated) → Run workflow → operation probe.
Prueba el receiver SSH y su self-test sin tocar Docker. Los cambios PR por sí
solos nunca ejecutan SSH. Si el host no es alcanzable desde GitHub-hosted
runners, configurar red privada autorizada antes de probar.

## Activar Continuous Deployment a producción (solo después de pruebas)
El motor remoto comprueba un JSON con propietario root en
/etc/talaeats/cd-approval.json y fecha de expiración <=30 días. No crearlo
con datos ficticios. Requiere:
- allow_automatic_production = true
- offsite_backup_verified = true
- isolated_restore_test_pass = true
- automated_backup_policy_verified = true
- branch = main
- expires_utc = fecha ISO8601 con zona horaria futura

Todos los valores anteriores solo pueden afirmarse después de verificar la
copia cifrada fuera de Kali por SHA256, una RESTAURACION REAL del dump PG16 y
media en ambiente aislado, un sistema de backup automatizado fuera del host
y una práctica de rollback. Un respaldo en OneDrive por sí solo NO basta.
El JSON root-owned será legible por el usuario deploy, pero NO escribible por
ese usuario. Después, habilitar TALAEATS_CD_ENABLED=YES en GitHub Environment.

Si no existen esas pruebas, fallará TALA_CD_BLOCKED antes de tocar producción.
Los cambios con Alembic HEAD nuevo también se rechazan automáticamente.
No ejecutar docker compose down -v, alembic downgrade, SQL restore ni pagos
LIVE desde este sistema. Las migraciones deben pasar por un proceso separado
de aprobación supervisada.

## Estado operativo
PR: código preparado y CI sintético; NO hay configuración SSH/secrets,
activación de Environment, prueba de conectividad GitHub→Kali ni deploy real.
El backend candidato ya construido en Kali por el operador sigue sin
reemplazar la versión productiva.
