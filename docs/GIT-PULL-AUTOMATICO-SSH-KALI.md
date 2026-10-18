# Git pull automático por SSH — Kali (simple)

Esta propuesta hace **solo** `git pull --ff-only origin main` en
`/home/alan/tala-backend-audit`, después de un push a `main`.
No llama a Docker, no reinicia servicios, no modifica DB/Redis/Stripe
y **no actualiza el código que ya corre dentro del contenedor backend**.

## Configuración única en GitHub

En **Settings → Secrets and variables → Actions** agregar estos **Repository secrets**:

- `KALI_SSH_HOST`: host SSH alcanzable **desde un runner de GitHub**.
- `KALI_SSH_PORT`: puerto SSH (normalmente `22`).
- `KALI_SSH_USER`: `alan`.
- `KALI_SSH_PRIVATE_KEY`: clave privada SSH *dedicada* para la automatización.
- `KALI_SSH_KNOWN_HOSTS`: línea de `known_hosts` con huella del host
  validada en Kali; no usar `StrictHostKeyChecking=no`.

La **clave pública** correspondiente debe agregarse a
`/home/alan/.ssh/authorized_keys` en Kali. Nunca incluir secretos en commits
ni pegarlos en el chat. Se recomienda limitar la clave a un usuario
de sincronización de mínimo privilegio y proteger `main` con revisión.

**Importante:** `192.168.100.45` es IP privada de tu LAN. Los runners
normales de GitHub no pueden alcanzarla directamente. Antes de probar,
establecer conectividad privada autorizada, por ejemplo Tailscale, o un
túnel SSH correctamente autenticado. El dominio HTTP Cloudflare Tunnel
existente no implica que SSH funcione por ese dominio.

## Primera prueba segura

1. Fusionar este PR a `main` cuando la red SSH y secrets estén listos.
2. GitHub → Actions → **Kali | git pull automático por SSH** →
   **Run workflow** → `operation=probe`. Debe salir `KALI_SSH_PROBE_OK`.
3. Después **Run workflow** → `operation=pull`.
   Debe salir `KALI_GIT_PULL_PASS <sha>`.
4. Crear la variable de repositorio `KALI_GIT_PULL_ENABLED=YES`
   **solo cuando el probe haya funcionado** para activar pull tras cada push.

El script aborta si el checkout de Kali no está en `main`, tiene cambios
locales rastreados o si Git requiere un merge no fast-forward.

## Qué NO hace

No es el despliegue efectivo de la API en producción porque Tala Eats
utiliza Docker Compose y la aplicación sigue ejecutando su imagen anterior.
Para cambiar la API en servicio se necesita una operación adicional de
actualización de Backend y Worker, con respaldo y recuperación validados.
Eso se mantiene **fuera** de este flujo simple, como pidió el usuario.
