# Tala Eats Node.js staging · incidente móvil y endurecimiento P0 (20-oct-2026)

## Alcance y línea base

- Rama de referencia realmente desplegada en Kali: `feat/node-kali-direct-pm2-release-20261020`, SHA `a39b93b6963d423ee71f1e47d652d9d4dda0f1a5`. Este PR NO despliega.
- Código Node en `node-backend/src/`: **21 archivos TypeScript** en la rama corregida. Se hizo un barrido estático focalizado de rutas, SQL parametrizado, marcadores de funciones no disponibles y secretos; **esto no constituye una auditoría formal exhaustiva** del repositorio ni un pentest.
- Tres apps Flutter usan `https://api-stage-talaeats.alan-palacios-dev.com/api/v1`; API pública y Stripe financial writes OFF.
- Backend Python productivo, PostgreSQL productivo, Cloudflare y ADMIN anteriores fuera de alcance.

## Incidentes reproducidos desde contratos reales

| Impacto | Causa en fuente | Acción |
|---|---|---|
| Restaurante, alta paso 3/3: `Documento no seguro` | `POST /uploads/onboarding-document` emite `/api/v1/uploads/onboarding-document/u<ID>-...jpg`, pero `POST /operations/onboarding` solo aceptaba `uploads/...` | Aceptar URL exacta; comprobar id de propietario, nombre aleatorio, categoría y propiedad en `media_assets`; rechazar referencias externas, ajenas y repetidas |
| Restaurante, fotos publicadas fallan | Flutter solo acepta HTTPS absoluto del mismo host, la API Node devolvía URL relativa | Emitir URL absoluta mediante origen fijo (sin usar cabeceras Host), conservar lectura de assets antiguos con URL relativa |
| Usuarios: restablecer contraseña no entrega correo | `auth` solo insertaba `email_outbox`; el worker anterior no lo consumía; enlace apuntaba a loopback `127.0.0.1:5173` | Enlace HTTPS Android App Link; proveedor opt-in Resend en worker; allowlist de destinatarios; outbox con bloqueo/idempotencia, caducidad y censura de tokens; respuesta uniforme 503 sin proveedor fuera de CI |
| Usuarios bajo tráfico: limitación compartida | El túnel conecta a Node desde loopback, haciendo que distintos usuarios compartieran el mismo bucket por IP | Leer solo `CF-Connecting-IP` de conexiones locales y validar formato IP; nunca confiar en X-Forwarded-For arbitrario |
| Sesión navegador HTTP | Cookie marcada `secure:false` | `HttpOnly Secure SameSite=Lax` (apps usan Bearer de la respuesta) |

## Correo de recuperación: falta configuración **operativa** en Kali

No existe forma legítima de entregar correos sin un proveedor autorizado. El código está preparado, **pero continúa desactivado** por defecto, con error claro en vez de falso mensaje de envío.

Agregar al entorno aislado de Node staging, una vez verificado el dominio remitente en Resend (nunca subir las claves a GitHub ni capturas):

```dotenv
STAGE_EMAIL_DELIVERY_MODE=resend
STAGE_EMAIL_RESEND_API_KEY=<secret-privado>
STAGE_EMAIL_FROM=Tala Eats <noreply@dominio-verificado>
STAGE_EMAIL_ALLOWED_RECIPIENTS=qa1@example.com,qa2@example.com
```

El worker PM2 existente debe reiniciarse junto con la API de staging después de aprobar el release. No introducir credenciales de Stripe LIVE. El enlace de recuperación usa el App Link Android registrado para `https://talaeats.alan-palacios-dev.com/restablecer?token=...`: verificar en teléfono de pruebas que Android realmente abre la app Node debug antes de anunciarlo funcional para usuarios. Si la asociación Android App Links no está verificada en APK debug, se requiere corregir el vínculo/app, no desactivar la verificación de tokens.

## Verificaciones incluidas

- E2E multipart con archivo JPG/PNG real, alta mediante contrato móvil, rechazo de referencia ajena, ruta inválida y duplicados.
- E2E fotos de cubierta y menú: HTTPS mismo host, lectura pública solo de medio publicado, DB consistente.
- E2E existentes de autenticación: token de recuperación hash, vencimiento, un solo uso, revocación de sesiones y anti-enumeración en modo CI sintético. En modo staging sin proveedor: fallo cerrado.
- Compilación TypeScript, Prisma migrations en PostgreSQL 15 desechable, Redis 8 efímero y suites existentes en GitHub Actions; no pruebas de pago reales.

## Auditoría siguiente, antes de producción

1. **P0 - integración real en móvil:** registro/restaurante/aprobación/admin, subida de imágenes, login y recuperación por correo real verificado. Instalar APK de staging solo sobre dispositivo/cuenta de prueba.
2. **P0 - exposición externa:** la API staging está publicada sin Zero Trust por decisión temporal del proyecto. Limitar datos/cuentas QA, reforzar rate limits, evitar PII y verificar abuse controls; el portal ADMIN no debe publicarse sin protección.
3. **P1 - contratos pendientes:** el inventario de rutas Python→Node es estructural; múltiples flujos financieros retornan 503 intencionalmente. No habilitar cobros/retiros ni declarar paridad funcional sin QA.
4. **P1 - imágenes y ficheros:** el parser multipart casero tiene límites de tamaño y firma, pero requiere fuzzing de fronteras y pruebas de archivos adversariales antes de gran volumen.
5. **P1 - outbox:** probar fallos del proveedor, concurrencia/crash, backoff y confirmación real del correo en entorno aislado; nunca mostrar secretos ni tokens en logs.
6. **P1 - seguridad:** revisión manual adicional de autorización por objeto en las rutas grandes (operational, parity, versions), auditación SQL de las consultas que usen `$queryRawUnsafe` y carga/rate limit por rutas.
7. **P2 - hardening general:** observabilidad, retención y purga de uploads/sesiones, pruebas E2E de las 3 apps, revisión de dependencias y auditoría externa.

**Estado:** cambios de código en PR de staging; el deployment en Kali debe ser manual y con rollback. Ni una prueba PASS en CI implica GO de pagos o producción.
