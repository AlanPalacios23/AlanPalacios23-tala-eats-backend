# TALA EATS — GitHub Actions → Tailscale → SSH → Kali GREEN

**Estado: código en PR, acceso SSH y auto-deploy aún NO activados.**

Stack correcto de Kali: talaeats-green, servicios api/worker/db/redis. Compose
/home/alan/talaeats-green-20261018/compose.yml y env local green.env.
Endpoint local 127.0.0.1:18182/api/v1/ready, Alembic f21i00000001.
Nunca desplegar con el operador anterior del proyecto talaeats-v3.
El dominio público aún usa el proxy antiguo y NO ha sido conmutado.

## 1. Red privada

Instalar Tailscale en Kali: https://tailscale.com/docs/install/linux.
Unir equipo a la tailnet, comprobar con sudo tailscale status y tailscale ip -4.
Los runners de GitHub no pueden alcanzar 192.168.100.45 directamente; usar IP
Tailscale 100.x.x.x. NO abrir puerto SSH de casa a Internet.

En la consola admin Tailscale definir tag:talaeats-ci y OAuth client con permiso
auth_keys y ese tag. GitHub usa tailscale/github-action@v4 con cliente OAuth ID y
secret, crea nodo efímero. Restringir la política grants para que el tag del
runner solo llegue al servidor Kali TCP:22. Ejemplo PARCIAL (no sustituir la
política existente; personalizar IP por IP Tailscale real):

    "tagOwners": {"tag:talaeats-ci": ["autogroup:admin"]},
    "grants": [{"src": ["tag:talaeats-ci"], "dst": ["100.x.y.z"], "ip": ["tcp:22"]}]

Revisar reglas grants existentes: permisos más amplios pueden prevalecer.

## 2. SSH

Generar un par de claves Ed25519 dedicado en equipo privado, jamás reusar llave
personal, poner privada SOLO en GitHub Environment Secret. Poner su parte PUBLICA
en /home/alan/.ssh/authorized_keys con prefijo:

    restrict,command="/usr/local/sbin/talaeats-green-cd-receiver" ssh-ed25519 AAAA... talaeats-green-github

Permisos de ~/.ssh = 0700 y authorized_keys = 0600.
Obtener scripts de PR revisada y colocar en Kali root-owned:

    sudo install -d -o root -g root -m 0755 /usr/local/libexec
    sudo install -o root -g root -m 0644 scripts/kali_green_cd.py /usr/local/libexec/talaeats-green-cd.py
    sudo install -o root -g root -m 0755 scripts/kali_green_cd_ssh_receiver.sh /usr/local/sbin/talaeats-green-cd-receiver

SSH acepta exclusivamente talaeats-green-cd probe,
talaeats-green-cd preflight SHA y talaeats-green-cd deploy SHA.
El probe ejecuta self-test y NO toca Docker.

Validar huella del host Kali por canal independiente ANTES de trust:

    sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256

Known hosts para hostname/IP Tailscale debe contener la línea ED25519 de Kali,
verificada contra huella anterior; no confiar a ciegas en ssh-keyscan.

## 3. GitHub

Crear Environment talaeats-production, permitir branch main, opcional revisores.
Guardar en ese Environment los siguientes 7 Secrets:

- TALAEATS_KALI_SSH_HOST: IP Tailscale del Kali, o MagicDNS .ts.net
- TALAEATS_KALI_SSH_PORT: puerto SSH, generalmente 22
- TALAEATS_KALI_SSH_USER: alan
- TALAEATS_KALI_SSH_PRIVATE_KEY: llave privada Ed25519 SOLO GitHub
- TALAEATS_KALI_SSH_KNOWN_HOSTS: línea Ed25519 host-key fijada
- TS_OAUTH_CLIENT_ID: OAuth client ID de Tailscale
- TS_OAUTH_SECRET: secreto OAuth Tailscale

Crear a nivel REPOSITORY (no de Environment) la variable Actions
TALAEATS_GREEN_CD_ENABLED=NO al principio; gate revisa vars antes de Environment.
No reutilizar flag TALAEATS_CD_ENABLED de la PR vieja.

## 4. Primera prueba

Tras fusionar la PR, preparar Tailscale y llave/receiver. En GitHub:
Actions > TALA EATS | GitHub Actions -> Tailscale SSH -> Kali GREEN >
Run workflow > operation=probe.
Éxito: GREEN_CD_ENGINE_PROBE_PASS.
No realiza despliegue ni requiere activar TALAEATS_GREEN_CD_ENABLED.

## 5. Antes de permitir despliegue automático

Aún no hay backup AUTOMATICO probado de la base GREEN más copia externa.
El backup cifrado antiguo del stack v3 sí fue restaurado en laboratorio, pero
NO autoriza preservar automáticamente datos futuros de green.

El motor exige dos archivos de evidencia root-owned en /etc/talaeats/
que solo se crearán tras comprobar realmente:
- green-cd-approval.json: project talaeats-green; branch main; booleanos
  auto_cd_approved, restore_drill_verified, offsite_backup_verified,
  green_automatic_backup_verified en true, expires_utc futuro <=30 días.
- green-cd-backup-proof.json: project talaeats-green;
  offsite_sha256_verified true; verified_at_utc dentro de últimas 24 horas,
  escrito por un sistema de backup VERIFICADO e independiente.

Si no hay evidencia, el despliegue fallará cerrado GREEN_CD_BLOCKED, aunque
la conexión SSH pruebe que funciona. No crear archivos falsos.

Cuando backups automáticos green+media y restore drill+SSH pasan, activar
REPOSITORY variable TALAEATS_GREEN_CD_ENABLED=YES.

## 6. CD verde

workflow_run de QA push/main success, coteja HEAD main y 5 gates CI para SHA:
QA, PostgreSQL/Redis, Finanzas, Container Build, Security Audit.
Tailscale SSH forced-command envía SHA exacto. El motor green valida
no-demo y pagos OFF, sin migrations nuevas, backend healthy y backup externo
verificado; construye imagen Docker non-root, preserva anterior y reemplaza
SOLO api+worker, prueba salud y hace rollback si falla.
No modifica bases/volúmenes ni Caddy, Cloudflared, frontend, DB v3 o Stripe.
Cambios de Alembic head exigen release supervisada.

Estado real: PR preparada, todavía SIN instalación/red/secretos/probe
y SIN despliegue automático autorizado.
