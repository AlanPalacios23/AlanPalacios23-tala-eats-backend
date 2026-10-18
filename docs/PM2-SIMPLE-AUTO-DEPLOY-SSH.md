# Tala Eats — auto deploy por SSH con git pull + PM2 (sin Docker)

Esta es una **alternativa para un VPS de pruebas separado**. No modifica Kali LIVE (PostgreSQL, Redis, Caddy, fotos, Stripe y pagos). Este PR es borrador, sin despliegue.

## Arquitectura sencilla

- API FastAPI con Python 3.13/Uvicorn en `127.0.0.1:18090`.
- PM2 administra `talaeats-pm2-api-stage` y `talaeats-pm2-worker-stage`.
- PostgreSQL 16 y Redis instalados nativamente en el VPS (el backend real los necesita; PM2 no los sustituye).
- Cloudflare Tunnel gratuito: dominio de **pruebas** a `http://127.0.0.1:18090`, sin Nginx y sin exponer el puerto de la API.
- GitHub Actions: primero prueba SSH con `operation=probe` sin deploy. Solo al poner `PM2_STAGE_AUTO_DEPLOY_ENABLED=YES`, cada push a `backend/**` en `main` hace `git pull --ff-only`, instalación de dependencias y `pm2 restart`.
- Las herramientas son gratuitas; **el VPS, dominio y almacenamiento pueden costar**.

## Una vez, en el VPS nuevo

1. Instala Python **3.13**, Node.js, PM2 (`sudo npm install -g pm2`), PostgreSQL 16, Redis, git, curl y cloudflared. Algunas distribuciones requieren repositorios externos para versiones 3.13/16.
2. Crea un **usuario Linux de despliegue sin sudo** y una base PostgreSQL **nueva de staging**, no la de Kali LIVE. Redis también debe ser de pruebas.
3. Configura para ese usuario una Deploy Key GitHub **de solo lectura**: el repositorio es privado. Luego clona:

   ~~~bash
   git clone git@github.com:AlanPalacios23/AlanPalacios23-tala-eats-backend.git ~/tala-eats-pm2-stage
   cd ~/tala-eats-pm2-stage
   git checkout main
   ~~~

4. La base PostgreSQL debe llamarse **`talaeats_stage`**, usar `127.0.0.1`, Redis de staging debe usar `127.0.0.1:6379/1` y las fotos deben ir a `$HOME/talaeats-stage-media`: son barreras para evitar accidentalmente acceso a producción.
5. Guarda tu configuración privada **solo en el VPS**: copia `deploy/pm2/staging.env.example` a `~/.config/talaeats-pm2-stage.env`, edita contraseñas/URL/dominio/JWT **de staging** y ejecuta `chmod 600 ~/.config/talaeats-pm2-stage.env`. No subas ese archivo a GitHub ni compartas sus valores. PostgreSQL, Redis, JWT y orígenes HTTPS son parámetros realmente necesarios; no se deben eliminar.
6. Arranca una vez sobre la nueva base de datos **de staging**:

   ~~~bash
   cd ~/tala-eats-pm2-stage
   python3.13 -m venv backend/.venv
   backend/.venv/bin/pip install -r backend/requirements.txt

   # Solo para base de STAGING vacía; NO en Kali LIVE.
   cd backend
   set -a
   source "$HOME/.config/talaeats-pm2-stage.env"
   set +a
   .venv/bin/alembic upgrade head
   cd ..

   pm2 start deploy/pm2/ecosystem.config.cjs
   pm2 save
   curl -fsS http://127.0.0.1:18090/api/v1/ready
   ~~~

   Activa el inicio tras reboot siguiendo el comando que muestre `pm2 startup`.

7. En el panel Cloudflare Zero Trust crea o usa un Tunnel **del VPS nuevo**, instala cloudflared como servicio con el token privado generado en el panel y añade un hostname **nuevo de pruebas** que apunte al origen `http://127.0.0.1:18090`. No apuntes el dominio LIVE al servicio de pruebas.

## En GitHub: 4 secretos y SSH

En **Settings → Environments** crea `talaeats-pm2-staging` y agrega:
- `PM2_SSH_HOST`: IP pública / DNS del nuevo VPS.
- `PM2_SSH_USER`: usuario Linux sin sudo.
- `PM2_SSH_PRIVATE_KEY`: llave privada SSH *dedicada a GitHub Actions*. Instala su pública en `~/.ssh/authorized_keys` del VPS.
- `PM2_SSH_KNOWN_HOSTS`: registro de host-key ED25519 **verificado por un canal independiente** contra la huella del VPS. No aceptes la huella de un simple `ssh-keyscan` sin comprobarla.

El puerto SSH del workflow es **22**. Protege el servicio SSH con llaves, firewall y usuario sin privilegios. La Deploy Key *VPS→GitHub* para git pull es **otra llave diferente** de la llave *GitHub Actions→VPS*.

**Condición de red imprescindible:** el GitHub Runner NO puede entrar a `192.168.100.45`, la IP local de Kali. El túnel Cloudflare de HTTP NO es acceso SSH directo. Este flujo **sin Tailscale ni otra conectividad privada** requiere un VPS público con SSH alcanzable desde GitHub.

Una vez fusionado este PR a `main` y configurado el VPS, ejecuta **Actions → Tala Eats | Auto deploy Git Pull + PM2 por SSH (staging) → Run workflow → `operation=probe`**. Exige `PM2_STAGE_SSH_PROBE_PASS`. Después arranca el staging manualmente y valida API, worker, base de datos y Redis; ejecuta `operation=deploy` como prueba supervisada. **Solo entonces**, en Settings → Secrets and variables → Actions → Variables, crea `PM2_STAGE_AUTO_DEPLOY_ENABLED=YES` para habilitar los pushes automáticos. Sin esa variable, los pushes no ejecutan SSH ni deploy. Este flujo **no contiene Docker ni Nginx ni comandos contra Kali producción**.

## Verificación y límites

`pm2 status`, `pm2 logs talaeats-pm2-api-stage --lines 50` y `curl -fsS http://127.0.0.1:18090/api/v1/ready` deben mostrar procesos sanos y `ready: true`.

El script comprueba fast-forward y SHA de `main`, **NO ejecuta migraciones automáticamente**, verifica el HEAD de la base, exige PostgreSQL local `talaeats_stage`, Redis local base `1`, media exclusiva y bloquea credenciales y operaciones de pago. La salud exige `ready/database/redis=true` y los dos procesos PM2 en línea. Si falla la salud, informa error; el rollback es **manual**. No hagas `git reset` sobre una base de datos ni toques los pedidos reales.

Una eventual sustitución de **producción** necesita un plan aparte para PostgreSQL, Redis, media, workers, webhooks y pagos. El cambio de Docker a PM2 NO es una actualización trivial sobre la infraestructura que ya está aceptando pedidos.
