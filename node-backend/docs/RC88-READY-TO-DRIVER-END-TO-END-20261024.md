# Tala Eats RC8.8: READY -> Driver, seguridad de punta a punta

Estado: **DRAFT — CI/staging aislado**. Se construye directamente sobre RC8.7 delivery cash PR #149 y pickup/Stripe PR #146. Sin merge a main (Python), sin despliegue Kali, sin Stripe LIVE, sin transferencias ni publicación en Play.

## Flujo verificado / política
1. Usuarios obtiene catálogo/precios desde el servidor; la nueva cotización DELIVERY sólo se ofrece cuando está permitido en staging. Coordenadas de origen y destino validadas, radio de restaurante, driver verificado, activo y conectado con GPS vigente en Redis. `STAGE_DRIVER_MAX_PICKUP_KM=8` default (1..30 configurable).
2. `POST /orders`: idempotencia por comprador + client_reference + HMAC del cuerpo, stock/baja ingredientes y ledger en transacción. CASH DELIVERY únicamente. Stripe delivery no disponible por precaución contable.
3. Restaurante: owner autenticado, pagos verificados, secuencia `received -> confirmed -> preparing -> ready`. Sólo `READY` confirmado por servidor inicia dispatch.
4. READY intenta asignación en el momento; conductor activo/verificado + ubicación Redis fresca (TTL 120s) + distancia a restaurante inferior a radio pickup. Claims de fila con `FOR UPDATE SKIP LOCKED`, una entrega activa por driver. Una oferta sólo revela datos de restaurante antes de aceptación.
5. La asignación se persiste en PostgreSQL, añade evento, notificación in-app y outbox; driver observa su `/driver/dashboard` autenticado (poll 5s en foreground + refresh inmediato al reanudar). No se promete FCM/push en segundo plano.
6. Si el API muere tras READY, todos los drivers están ocupados o no hay ubicación válida, el worker de staging busca hasta 10 READY sin driver cada 15s, verifica marca de checkout firmado, y reintenta bajo la misma exclusión; no crea pedido ni Stripe charge duplicados.
7. Driver `assigned -> picked_up -> on_the_way -> delivered` con PIN seguro, antibruteforce y registro único `cash_delivery_collection`. Dinero físicamente cobrado por el repartidor **no equivale** a fondos disponibles para payouts.
8. Restaurante usa polling de 6s foreground para nuevos pedidos. La app Usuario se basa en RC8.7 mobile v1.0.45; revalida quote y bloquea Stripe delivery.

## Gating y métricas
- `STAGE_DELIVERY_CASH_CHECKOUT_ENABLED=false` por defecto, rechazo total en producción.
- Redis no disponible, GPS vencido o repartidor fuera de radio = checkout no permitido. El registro de base `isOnline` NO garantiza presencia real.
- Scans/queries acotados, una sola operación MGET de hasta 100 perfiles, timeouts de Redis. Escala adicional requiere colas geográficas y métricas de aceptación.
- Worker registra sólo nombre de fallo, no secretos, ubicación o datos personales.
- Fuente binaria Figtree/Bricolage no estaba en GitHub: app Restaurante usa temporalmente fuente de sistema para permitir compilar, hasta reincorporar recursos de licencia auditada.

## Criterios NO-GO
- E2E real con tres APKs en Android, restauración sesión, GPS permisos, Ready/driver asignado, notificación real y PIN; manifest prod.
- Stripe TEST y LIVE DELIVERY con webhooks y contabilidad propia, reembolsos/disputas y saldos; Connect pagos/transferencias siguen OFF.
- Repartidores reales verificados, disponibilidad, área de operación, contacto/soporte, remedio ante pedido listo sin repartidor y proceso de efectivo.
- AAB de publicación firmada, telemetría de fallos y prueba rollback PostgreSQL/PM2/Kali.
- Distancia actual geodésica, no kilometraje de calles; verificar estrategia de tarifa de entrega antes de producción.

Nuevas pruebas: RC8.8 full PG15/Redis8 con servidor + worker, GPS vencido/distante, READY retry durable tras conductor temporalmente offline, PIN y contabilidad sin duplicados; CI Flutter 3 apps en matrix. No pasar a release antes de CI verde.
