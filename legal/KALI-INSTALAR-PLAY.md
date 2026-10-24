# TALA EATS | Instalación en Kali (sin tocar pagos ni backend)

Este repo contiene los documentos para Play Console, pero la conexión de GitHub no ejecuta comandos en el servidor Kali. Caddy en Docker y Cloudflare Tunnel han atendido el dominio; no suponer que modificar Nginx del host publicará una ruta.

## 1. Diagnóstico de proxy, de solo lectura
Desde la cuenta de Kali con acceso a GitHub:

```bash
gh repo clone AlanPalacios23/AlanPalacios23-tala-eats-backend ~/talaeats-legal-src -- --branch feat/talaeats-public-privacy-play-20261024
cd ~/talaeats-legal-src
python3 legal/kali-preflight.py
python3 legal/kali-stage.py
```

Si ya existe la carpeta, usar un checkout nuevo para evitar sobrescribir archivos productivos, o verificar el SHA de ese checkout en una ubicación no productiva. No publicar nada antes de revisar el resultado.

## 2. Instalar solo los HTML (NO los hace visibles)

```bash
cd ~/talaeats-legal-src
python3 legal/kali-stage.py --stage
```

Copia los dos HTML a /var/www/talaeats-legal/privacidad/index.html y /var/www/talaeats-legal/eliminar-cuenta/index.html si no existen; falla ante cualquier destino ya existente. No instala servicios, no reinicia Caddy ni Nginx, no cambia Cloudflare, APIs, Docker, Stripe ni DB.

## 3. Activación del proxy existente

Las dos rutas deben publicarse en el reverse proxy real con prioridad sobre el frontend y sin afectar /api/v1:
- Si es Nginx del host, usar legal/NGINX-LOCATIONS.conf solamente dentro del server TLS del dominio, y ejecutar nginx -t antes de reload.
- Si es Caddy Docker, se necesita conocer el Caddyfile, los mounts y la red para instalar un static route persistente; no copiar HTML al filesystem efímero del contenedor.
- Si Cloudflared apunta directamente a otro puerto, se debe mantener su ingress y enlazar al origen correcto.

No ejecutar un cambio de proxy sin una copia del archivo original, validación sintáctica y estrategia de reversión.

## 4. Validación web antes de Google Play

```bash
curl -fLsS -o /dev/null -w 'privacy: %{http_code} %{content_type}\n' https://talaeats.alan-palacios-dev.com/privacidad
curl -fLsS -o /dev/null -w 'delete: %{http_code} %{content_type}\n' https://talaeats.alan-palacios-dev.com/eliminar-cuenta
curl -fLsS -o /dev/null -w 'health: %{http_code}\n' https://talaeats.alan-palacios-dev.com/api/v1/health
```

Todas las URL deben estar disponibles sin login, bloqueo geográfico ni desafío Cloudflare. El HTML debe mostrar los datos reales del responsable, email de contacto, cómo eliminar la cuenta y plazos aplicables. Probar que ese correo recibe solicitudes.

En Play Console: no marcar «Mi app no permite que los usuarios creen una cuenta». URL privacidad = /privacidad; URL eliminación = /eliminar-cuenta. Esta página solo inicia la solicitud por correo; hay que gestionar realmente las solicitudes y eliminar datos asociados en backend.
