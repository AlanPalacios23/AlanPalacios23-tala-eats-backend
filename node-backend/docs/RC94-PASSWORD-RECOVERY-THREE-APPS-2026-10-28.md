# Tala Eats RC9.4 — Recuperación de contraseña de las tres aplicaciones

Estado: **CANDIDATO NO DESPLEGADO**. Rama `feat/rc94-password-recovery-all-roles-20261028`, PR #164. Esta entrega se basa en las correcciones de seguridad RC9.3 (PR #163), también sin despliegue confirmado. El último LIVE confirmado por el operador sigue siendo `8f4ea97c23ae8372d171f277f5615c719beed240`.

## Causas comprobadas

1. El endpoint `POST /api/v1/auth/password/forgot` solo aceptaba solicitudes con correo de staging habilitado; en LIVE respondía 503.
2. El envío real del outbox (`src/email.ts`) estaba montado únicamente en el worker de staging. El worker PM2 productivo no lo ejecutaba.
3. El link de recuperación anterior `/restablecer?token=...` carecía de una página compartida del backend. Usuarios intentaba gestionar un enlace móvil; Repartidor podía solicitarlo pero no completar el flujo en la app, y Restaurante no mostraba el botón.
4. El endpoint carecía de un presupuesto distribuido por correo: limitar solo IP podía permitir inundar repetidamente una dirección con enlaces.

## Contrato compartido entre apps

- `POST /api/v1/auth/password/forgot` con `{"email":"usuario@ejemplo.com"}` devuelve 202 y un mensaje genérico tanto si existe como si no.
- Enlace de correo: `https://talaeats.alan-palacios-dev.com/api/v1/auth/password/reset-page?token=...`.
- `GET /api/v1/auth/password/reset-page?token=...` muestra formulario de nueva contraseña en navegador, sin requerir un Android App Link.
- `POST /api/v1/auth/password/reset-page` recibe `application/x-www-form-urlencoded`: `token`, `password`, `confirm`.
- Para clientes nativos: `POST /api/v1/auth/password/reset` con `{"token":"...","password":"..."}` mantiene el contrato original.
- El token se guarda en BD solamente como SHA-256, caduca en 30 minutos, se usa una vez y revoca todas las sesiones anteriores tras cambiar la contraseña.
- Redis limita a 3 solicitudes por correo/15 minutos (más límite por IP). Se conserva respuesta genérica para evitar identificación de cuentas.

## Requisitos para envío de correo real

**No poner claves en GitHub, chats ni comandos con `set -x`.** La cuenta Resend necesita un dominio remitente verificado y permiso de envío. Provisionar de manera segura las variables en el archivo privado del worker y la API:

```ini
LIVE_AUTH_EMAIL_DELIVERY_MODE=resend
LIVE_AUTH_EMAIL_SENDER_APPROVED=true
LIVE_AUTH_EMAIL_RESEND_API_KEY=<secret from private credential store>
LIVE_AUTH_EMAIL_FROM=<verified sender mailbox>
```

Sin estas variables, la recuperación LIVE **permanece desactivada** y no se debe anunciar como funcional. La API y el worker deben tener la misma configuración, no solo uno de ellos. Configuración errónea falla cerrada al iniciar. El worker LIVE procesa únicamente correos de recuperación; no envía todos los mensajes viejos de bienvenida que estén en el outbox.

## Calidad y seguridad

- CI con PostgreSQL 15 y Redis 8 efímeros y respuestas del backend HTTP reales.
- Probar `customer`, `restaurant` y `driver`, recuperación completa, contraseña anterior rechazada, token consumido no reutilizable, sesiones anteriores revocadas, y respuesta uniforme para correos desconocidos.
- Probar Redis sin conexión, límite de envíos y que una cola fallida no afecte webhooks de Stripe ni su heartbeat.
- Verificar remitente y DNS en Resend y probar un correo de entrega real a una cuenta autorizada antes de incorporar restaurantes o repartidores.
- Comprobar en Kali la configuración LIVE con una inspección **sin revelar secretos** y el inventario de migraciones. Hacer backup encriptado, restauración aislada, despliegue PM2 con rollback y prueba pública HTTPS.
- RC9.4 no habilita transferencias, desembolsos Connect o cobros adicionales.

## Pendientes móviles

- Usuarios ya expone solicitar y consumir reset nativo; puede usar el enlace de recuperación web de manera independiente.
- Repartidor ya expone solicitar recuperación; el enlace web completará el cambio de contraseña.
- Restaurante todavía debe agregar un botón para llamar el contrato `POST /auth/password/forgot`; el backend por sí solo no puede crear ese botón en un APK ya instalado.

**No declarar “correos LIVE funcionando” hasta verificar dominio, proveedor, recepción real e instalación en el servidor.**
