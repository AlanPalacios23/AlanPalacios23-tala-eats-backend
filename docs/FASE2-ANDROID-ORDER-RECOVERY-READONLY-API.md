# F2.07 · Recuperación de pedido por referencia sin recrear compra

Ruta candidata: `GET /api/v1/orders/by-reference/{client_reference}`.

- Autenticación obligatoria, solo consulta pedidos del propio `user.id`.
- Una referencia ajena y una inexistente producen exactamente HTTP 404.
- Devuelve el mismo contrato `OrderPublic` que `/orders/mine`,
  incluido PIN solo para su cliente autorizado.
- Exige referencia de 1–80 caracteres seguros; cabecera
  `Cache-Control: private, no-store` en respuesta de éxito.
- Hace solo SQL `SELECT`, sin cargos, reservas de stock,
  cambios de estado, webhooks, transferencias ni reintegros.
- La referencia puede permanecer en PostgreSQL más allá de las 24 horas
  de caché idempotente Redis.
- El cliente Android debe **guardar su referencia antes** de POST,
  recuperarla tras cerrar/abrir aplicación e invocar GET antes de
  autorizar un nuevo checkout. La app actual aún no hace esa persistencia.

Pruebas en `test_phase2_order_reference_lookup.py`: lectura repetida
sin mutación, propiedad individual, mismo texto para dos cuentas,
usuario anónimo/ajeno, referencias inválidas.

**F2.07 y el check Android de recuperación tras reinicio siguen pendientes**
de persistencia segura real y QA APK instalada. Esta nueva ruta por
sí misma no es una certificación E2E ni se ha desplegado en Kali.
