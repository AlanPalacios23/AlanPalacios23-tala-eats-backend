# RC144 — Foto persistente de repartidor (backend Node)

## Objetivo y límites
El conductor autenticado sube o cambia su propia foto. Se persiste una URL
aleatoria en `users.avatar_url` (columna **ya existente**), sin migraciones.
`driverDashboard.user.avatar_url` y `orders[].driver_info.avatar_url` son
la única fuente de verdad en PWA Flutter/paridad; no hay ruta de listado de
repartidores. El conductor debe estar asignado a ese pedido para que la UI
de Clientes y Restaurantes presente su nombre y foto.

**No habilita efectivo a domicilio, Stripe Connect, payouts, dispatch o PIN.**

## Contrato
- `POST /api/v1/driver/avatar`: sesión cookie/Bearer válida de repartidor
  activo; `Content-Type: image/jpeg|image/png|image/webp`, cuerpo binario
  hasta 4 MiB. Sharp valida la decodificación, formato y dimensiones; rechaza
  animaciones; reencodifica a WebP 512 px (sin metadatos ni GPS/EXIF).
  Respuesta HTTP 201: `{avatar_url:"/api/v1/driver/avatar/<40hex>.webp",url:"..."}`.
- `GET /api/v1/driver/avatar/<40hex>.webp`: ruta opaca para una foto pública
  no confidencial. No devuelve documentos, GPS, teléfono ni datos de cuenta.
  Tiene `nosniff`, `same-site` e imagen WebP, sin directorio/listados.
  El caché del proxy Nginx existente puede aplicar `no-store`.
- `PATCH /api/v1/auth/me` ya no permite al rol driver fijar URLs externas
  de fotos. No afecta modificaciones de nombre y teléfono.
- En asignación, el backend devuelve `driver_info.avatar_url` solo con la
  ruta canónica interna, o null. No agregar fotos al feed de ofertas sin
  conductor asignado.

## Requisitos de almacenamiento
- Provisión administrada por operador en Kali, no desde el backend:
  `/srv/talaeats-media/driver-avatars`. El directorio debe existir y ser
  escribible **solo** para `tala-node-stage`. **Nunca usar** una ruta bajo
  `/home/tala-node-stage/tala-node-releases`, `/tmp`, el frontend dist,
  el directorio del repositorio ni un enlace simbólico.
- Configuración explícita en entorno de backend:
  `DRIVER_AVATAR_UPLOAD_ENABLED=true`
  `DRIVER_AVATAR_MEDIA_DIR=/srv/talaeats-media/driver-avatars`
  NO ACTIVAR en LIVE hasta verificar staging, backup/restauración y que las
  tres PWAs consuman imágenes por la ruta `/api/v1/`.
  Sin la configuración, POST falla 503 de forma segura.
- Hacer copia de seguridad del volumen de imágenes **junto con** PostgreSQL.
  La URL en la DB no reemplaza los bytes del archivo. Tras migrar de Kali,
  restaurar ambos; no activar feature si la carpeta no está disponible.
- Mantener versiones anteriores por retención de al menos 30 días para que
  pedidos antiguos y pestañas abiertas no pierdan la foto. El GC debe
  ejecutarse aparte, después de comprobar que las URLs no se referencien en
  `users.avatar_url`. **No incluir borrado automático en este release**.

## Seguridad y QA obligatorios antes de LIVE
1. Actualizar `node-backend/package-lock.json` y `npm ci` con Node 24;
   ejecutar `npm run build && npm test` y todos los gates financieros
   existentes sin cambiar flags LIVE.
2. Stage autenticado: subir foto JPG/PNG/WEBP de repartidor verificado;
   comprobar `201`, URL generada, `GET image/webp` y `auth/me`.
   Cambiar foto, cerrar sesión, iniciar sesión en otro teléfono y verificar
   misma URL desde backend. Reiniciar API/worker sin perder archivos.
3. Comprobar 401 sin cookie, 403 para customer/restaurant, 415 con MIME
   falso/malformed/svg/pdf, 413 tamaño excedido, 429 límite de subidas y
   503 si almacenamiento/Redis no está disponible. Ninguna escritura DB ante
   fallo; contenido EXIF/GPS no debe sobrevivir a la transformación.
4. Cliente y restaurante solo ven el avatar cuando el pedido posee
   `driver_info` y estados `assigned/picked_up/on_the_way/delivered`.
   Antes de asignación no se expone ninguna identidad.
5. Confirmar que los hosts Clientes, Restaurantes y Repartidores proxifican
   `/api/v1/driver/avatar/*` al mismo backend y nunca a un directorio público
   local separado. Verificar en Android e iPhone PWA, con imágenes cacheadas,
   cambio de foto y degradación sin imagen.
6. Producir backup y rollback de backend LIVE antes de actualizar PM2.
   El backend de RC143 actualmente desplegado tiene SHA
   `f92f5d9a52856f24e155dcbc140dcff0e266056a`.
   **No modificar release activo** hasta aprobación expresa y plan testado.

## Rollout acoplado
Primero backend RC144 con flag OFF y volumen persistente provisionado.
Después PWA RC144 de Repartidores, Clientes y Restaurantes. Verificar con
cuenta real. Encender feature flag de forma controlada en backend una vez
los endpoints y respaldos estén probados. Si falla, OFF y restaurar snapshot;
los pedidos, pagos y disponibilidad quedan inalterados.
