# Tala Eats · Cloudflared real → Node 18190 y páginas legales 18191

Diagnóstico de Kali (24/10/2026):
- `cloudflared tunnel ingress rule https://talaeats.alan-palacios-dev.com/privacidad` → `/etc/cloudflared/config.yml` regla #0, `http://127.0.0.1:18190`.
- Puerto `127.0.0.1:18190`: proceso Node; API `/api/v1/health` devuelve HTTP 200.
- Servicio Nginx inactivo; NO usarlo ni cambiar Node para estas páginas.
- Ambos HTML instalados en `/var/www/talaeats-legal/{privacidad,eliminar-cuenta}/index.html`.

## 1. Obtener el último commit de la rama en checkout aislado

```bash
cd ~/talaeats-legal-src
git fetch origin feat/talaeats-public-privacy-play-20261024
git pull --ff-only origin feat/talaeats-public-privacy-play-20261024
```

El checkout NO debe ser el directorio productivo de Node. No hacer `git reset --hard`.

## 2. Instalar servidor estático independiente

```bash
python3 legal/install-local-origin.py
python3 legal/test-server.py
python3 legal/install-local-origin.py --install
sudo systemctl is-active talaeats-legal-static
curl -fIs http://127.0.0.1:18191/privacidad
curl -fIs http://127.0.0.1:18191/eliminar-cuenta
```

Exigir HTTP 200 con `content-type: text/html` en las dos URL. El nuevo servicio escucha SOLO 127.0.0.1:18191 como www-data. No toca Cloudflared y por lo tanto aún no cambia el tráfico público.

Si falla, NO continuar. Investigar con `sudo systemctl status talaeats-legal-static --no-pager`.

## 3. Crear candidato Cloudflared sin modificar LIVE

```bash
sudo python3 legal/prepare-cloudflared-routes.py
sudo python3 legal/prepare-cloudflared-routes.py --write-candidate
```

La herramienta solo acepta UNA regla preexistente del dominio con origen EXACTO `http://127.0.0.1:18190` y sin `path`. Inserta ANTES una regla exacta que envía solo `^/(privacidad|eliminar-cuenta)/?$` a `http://127.0.0.1:18191`.

Crea `/etc/cloudflared/config.yml.talaeats-legal-candidate` (archivo root 0600). Ejecuta cuatro validaciones: sintaxis, dos URLs legales hacia 18191, API health hacia 18190. NO reemplaza el archivo del túnel ni reinicia. Abortará si existen ya reglas o la configuración es inesperada.

## 4. Conmutación manual con respaldo

**ATENCIÓN:** reiniciar Cloudflared puede interrumpir durante unos instantes todas las aplicaciones y webhooks que utilicen ese túnel. Elegir un momento sin pedidos/pagos y con posibilidad de verificar la recuperación inmediatamente; no hay garantía de cero interrupción.

Solo si el candidato pasó la validación y los HTML respondieron 200 local:

```bash
sudo cp -a /etc/cloudflared/config.yml /etc/cloudflared/config.yml.pre-legal-20261024
sudo cp /etc/cloudflared/config.yml.talaeats-legal-candidate /etc/cloudflared/config.yml
sudo cloudflared tunnel ingress validate
sudo cloudflared tunnel ingress rule https://talaeats.alan-palacios-dev.com/privacidad
sudo cloudflared tunnel ingress rule https://talaeats.alan-palacios-dev.com/eliminar-cuenta
sudo cloudflared tunnel ingress rule https://talaeats.alan-palacios-dev.com/api/v1/health
```

Comprobar que `/privacidad` y `/eliminar-cuenta` van a 18191 y `/api/v1/health` sigue a 18190, antes de reiniciar.

```bash
sudo systemctl restart cloudflared
sudo systemctl is-active cloudflared
curl -fLsS -o /dev/null -w 'PRIVACY_HTTP_%{http_code} %{content_type}\n' https://talaeats.alan-palacios-dev.com/privacidad
curl -fLsS -o /dev/null -w 'DELETE_HTTP_%{http_code} %{content_type}\n' https://talaeats.alan-palacios-dev.com/eliminar-cuenta
curl -fLsS -o /dev/null -w 'API_HTTP_%{http_code} %{content_type}\n' https://talaeats.alan-palacios-dev.com/api/v1/health
```

## 5. Rollback del túnel si falla

```bash
sudo cp /etc/cloudflared/config.yml.pre-legal-20261024 /etc/cloudflared/config.yml
sudo cloudflared tunnel ingress validate
sudo systemctl restart cloudflared
curl -fIs https://talaeats.alan-palacios-dev.com/api/v1/health
```

El origen estático podrá seguir activo, pero sin regla Cloudflared no recibe tráfico exterior. No tocar `talaeats-legal-static` durante el rollback del túnel.

## 6. Google Play

Después de verificar **HTTP 200 text/html público**:
- URL de privacidad: `https://talaeats.alan-palacios-dev.com/privacidad`
- URL de eliminación de cuenta: `https://talaeats.alan-palacios-dev.com/eliminar-cuenta`
- No marcar la casilla «Mi app no permite que los usuarios creen una cuenta».
- Eliminar cuenta desde aplicación: `Perfil > Privacidad > Eliminar mi cuenta`.
- Verificar que `alanpalacios284@gmail.com` recibe correos y que se tramitan solicitudes. Una página no elimina datos automáticamente.

Validar si «TALA EATS» identifica suficientemente al responsable legal, y confirmar que el aviso describe los tratamientos y proveedores reales. No publicar afirmaciones no cumplidas.
