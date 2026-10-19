# TALA EATS · Auth v0.2 · Plan de compatibilidad Python → Node

**Estado:** implementación en rama DRAFT PR #81; **CI PostgreSQL15 + Redis8 PASS**, NO desplegada en Kali; AUTH desactivada por defecto. Código fuente Python: \`backend/app/routes/auth.py\`, \`backend/app/security.py\`, \`backend/app/deps.py\`, \`backend/app/schemas.py\`, \`backend/app/wallet.py\`.

## Implementado (opt-in)

| Python API | Node con AUTH_V02_ENABLED=true | Nota |
|---|---|---|
| POST /api/v1/auth/register | CI E2E PASS | Registra customer; PBKDF2 600k; inicializa Wallet BRONZE 0.00, notificación y email_outbox pending. **No envía todavía email** |
| POST /api/v1/auth/login | CI E2E PASS | Email normalizado, password PBKDF2, TOTP si habilitado, revocación de sesiones, respuesta JSON mobile |
| POST /api/v1/auth/logout | CI E2E PASS | Revoca sesión por SHA256(token) y elimina cookie |
| GET /api/v1/auth/me | CI E2E PASS | Bearer/cookie, sesión persistida con jti, device token opcional |
| PATCH /api/v1/auth/me | CI E2E PASS | Solo name, phone, avatar_url, birth_date; bloquea role |
| GET /api/v1/auth/devices | CI E2E PASS | 100 más recientes, current/trusted/active |
| POST /api/v1/auth/devices/revoke-others | CI E2E PASS | Revoca otras sesiones, audit event |
| POST /api/v1/auth/devices/{device_id}/revoke | Implementado, E2E individual pendiente | Solo sesiones propiedad del usuario; audita |
| GET /api/v1/auth/google/config | CI E2E PASS, disabled | Sin client ID real |
| POST /api/v1/auth/google | HTTP 503 deliberado | OAuth de Google **NO implementado** |
| POST /api/v1/auth/password/forgot | NO implementado | Exige sender SMTP real + outbox durable |
| POST /api/v1/auth/password/reset | NO implementado | Exige expiración, único uso, revocación de sesiones, auditoría |

El núcleo \`src/auth/crypto.ts\` implementa el formato Python PBKDF2-SHA256 600000, JWT HS256 con exp/iat/sub/jti, prueba opcional X-Device-ID, TOTP RFC6238 6 dígitos y ventana ±1. Sus tests y todas las pruebas estáticas del staging se ejecutan con \`npm test\`.

**No pasar tráfico Flutter ni datos Python LIVE aún.** A diferencia del backend Python, el envío de correos, las banderas de fraude compartido, Google OAuth, endpoints 2FA setup, otros módulos y Wallet financiero están pendientes. Nunca considerar el outbox como un correo ya enviado.

## Mantener seguro Kali estable

El backend del servidor opera hoy con \`AUTH_V02_ENABLED\` ausente → valor por defecto \`false\`. No cambiar la bandera ni migrar tablas \`users\` a Kali sin un despliegue controlado de staging, CI verde y respaldo previo. En la rama PR #81 hay una migración NUEVA \`20261019_auth_phase_a\` que se usa únicamente sobre una DB aislada PostgreSQL15 creada para CI. El Python productivo conserva otra DB y sus propias tablas.

Antes de cualquier habilitación futura, usar un secreto JWT **aleatorio y nuevo** de mínimo 40 caracteres en el \`.env\` privado de \`tala-node-stage\` (no copiar JWT_SECRET de Python). \`AUTH_V02_ENABLED=true\` sin \`AUTH_JWT_SECRET\` rechaza el arranque. No poner secretos en logs ni GitHub.

### Evidencia CI

- Unit/node: \`npm ci\`, Prisma client, Prisma validate, TypeScript build, password/JWT/TOTP tests + seguridad staging.
- E2E PostgreSQL15 + Redis8 descartables: schema migrations, \`POST register\` status201, duplicado409, login válido200 e inválido401, \`GET me\`, actualización de perfil sin escalada de rol, device attestation errónea401, dos sesiones, revoke others invalida el otro JWT, logout invalida el JWT actual, comprobar tablas Wallet/notifications/audit/outbox.
- No hay cobro, transferencia, payout ni autorización Stripe LIVE.

## Siguientes incrementos

1. Email sender/outbox fiable + recuperación de contraseña, revocación total de dispositivos, rate limits de email.
2. Google ID token verificado contra audiencia y emisor (nunca confiar en payload del cliente sin verificar), Google account linking.
3. Risk/fraud, notificaciones y auditoría con paridad Python, 2FA setup/enrollment seguro.
4. Catálogo restaurantes/menú y pruebas contractuales con Flutter/Android.
5. Pedidos \`client_reference\`, inventario, ciclo de vida y outbox transaccional. Después driver/merchant/admin y finanzas (TEST únicamente).

En cada incremento: extraer endpoints/modelos/validaciones del Python **antes** de implementar, luego Prisma migrations en DB aislada, CI E2E, revisión humana, respaldo stage y despliegue controlado. No se marcará 252/252 hasta terminar.
