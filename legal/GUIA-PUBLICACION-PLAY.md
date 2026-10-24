# TALA EATS | Páginas legales para Google Play (24/10/2026)

Preparadas para la aplicación Tala Eats Usuarios. Este PR NO modifica producción, no despliega en Kali, no publica en Play Console y no toca Stripe/FCM. Las páginas son HTML + CSS, responsive, sin JavaScript ni rastreadores.

## URL previstas (no verificadas como públicas)
- https://talaeats.alan-palacios-dev.com/privacidad
- https://talaeats.alan-palacios-dev.com/eliminar-cuenta

## Estado actual de datos legales (24/10/2026)
- Nombre indicado por el usuario como responsable: **TALA EATS**. Validar antes de publicar si este nombre corresponde a una entidad legalmente identificable o si el responsable es una persona física con nombre completo.
- Correo de privacidad indicado por el usuario: **alanpalacios284@gmail.com** (ya agregado a ambas páginas). Comprobar que efectivamente recibe y atiende solicitudes ARCO y eliminación.
- **BLOQUEO PENDIENTE: __DOMICILIO_LEGAL__**. Sustituirlo por un domicilio verdadero de contacto publicable apropiado para el responsable; no inventar ni colocar una dirección particular sin consentimiento expreso.

No publicar páginas mientras falte este domicilio o sin verificar la identidad legal y el canal de contacto. Se recomienda revisión legal mexicana de la LFPDPPP antes de publicar.

## Preparación y montaje en el Kali actual
1. Confirmar si la URL pública pasa por Nginx del host, Caddy o un contenedor Cloudflared. Revisar configuración real, respaldo y existencia de rutas /privacidad, /eliminar-cuenta.
2. En una copia local del repo, después de sustituir las cadenas y revisar texto, ejecutar:
   python3 legal/validar_legal.py
   Debe terminar con PASS; cualquier placeholder bloquea.
3. Solo si el Nginx del host atiende el dominio y dispone de acceso a los archivos:
   sudo install -d -m 0755 /var/www/talaeats-legal/privacidad /var/www/talaeats-legal/eliminar-cuenta
   sudo install -m 0644 legal/site/privacidad/index.html /var/www/talaeats-legal/privacidad/index.html
   sudo install -m 0644 legal/site/eliminar-cuenta/index.html /var/www/talaeats-legal/eliminar-cuenta/index.html
4. Insertar el contenido de legal/NGINX-LOCATIONS.conf DENTRO del server HTTPS existente. No crear server paralelo ni reemplazar el reverse proxy principal.
5. Ejecutar sudo nginx -t. SOLO si pasa, sudo systemctl reload nginx. Si Nginx está en contenedor, adaptar el mount y la ruta tras revisar Docker Compose, sin asumir que /var/www/ es visible allí.
6. Abrir ambas URLs en una ventana privada, desde red ajena, sin sesión y sin VPN. Rechazar 403/404/503, HTML de Cloudflare, redirección a login, error de certificado o placeholders visibles.
7. En Play Console > Contenido de aplicación > Política de privacidad ingresar la URL /privacidad.
8. En Seguridad de los datos > Eliminación de cuenta ingresar /eliminar-cuenta y verificar que el correo sí permita iniciar solicitudes sin reinstalar Tala Eats.
9. En siguiente actualización Android, enlazar también la página pública desde Ajustes/Privacidad, conservando aviso in-app si está actualizado.

## Validaciones recomendadas de red
curl -fLIsS --max-time 15 https://talaeats.alan-palacios-dev.com/privacidad
curl -fLIsS --max-time 15 https://talaeats.alan-palacios-dev.com/eliminar-cuenta

Google Play exige sitio HTML público, accesible y no editable y una vía web para solicitar eliminación si la app crea cuentas. Publicar los HTML sin proceso efectivo de recepción/tramitación de solicitudes NO satisface esa obligación.

## Funcionalidades descritas en lenguaje condicional
Ubicación, cobro Stripe y notificaciones Firebase: la política informa el tratamiento cuando se habilitan dichas funciones. La publicación de la política no las activa, no soluciona backend/checkout y no representa certificación de prácticas operativas.

## Observaciones
El responsable debe confirmar el texto final, proveedores reales, conservación, recepción de correos y derechos ARCO. No dar una URL de Google Play por válida hasta que la petición HTTPS pública funcione.
