# TALA EATS RC8.7 — Entrega a domicilio CASH, módulo aislado de staging (24-oct-2026)

## Estado y alcance
- **No producción, no despliegue Kali, no Stripe LIVE, no transferencias Connect.**
- Desarrollo sobre RC8.7 pickup #146, sin modificar main Python.
- Entregas **en efectivo** con repartidor Tala Eats autenticado y verificado. No se anuncia tarjeta a domicilio.
- Habilitación sólo al activar conjuntamente `STAGE_PICKUP_CASH_CHECKOUT_ENABLED=true`, `STAGE_DRIVER_DELIVERY_ENABLED=true`, `STAGE_DELIVERY_CASH_CHECKOUT_ENABLED=true` en **staging**. Producción rechaza la bandera.
- La ruta usa cliente autenticado, restaurante verificado/abierto, origen configurado explícitamente (no coordenadas seed), destino válido, radio de entrega, stock disponible, perfil de repartidor verificado y conectado. El alta de pedido vuelve a verificar todas estas condiciones bajo transacción.

## Contrato de precios (NO confundir con tarifa vial)
- `POST /api/v1/orders/delivery-quote` devuelve subtotal real del catálogo, tarifa servicio, entrega, propina, total, distancia redondeada a 0.001 km y pago estimado de repartidor. Es **no vinculante** y no reserva ni realiza cobros.
- Distancia: fórmula geodésica Haversine, origen `restaurants.lat/lng`, destino del comprador. **NO** distancia por carretera ni promesa de ETA. No simular una API de rutas. Sólo los mercados/radios configurados y verificados pueden operar.
- Política por defecto v1.6.2: comisión comercio 15 % de productos, tarifa cliente 7 % (tope $25), envío $35 hasta 2 km y $5/km adicional, pago repartidor según `calculateDefaultCommercial` (base mínima $32). v1.5.2: envío mínimo $39. Los precios finales siguen en backend; los cambios deben hacer que el cliente reconfirme antes de crear pedido.
- Nunca abrir delivery Stripe en `/orders/payment-methods` mientras falte conciliación con pagos, recibos y driver. Cliente Flutter debe permitir únicamente efectivo en domicilio cuando se anuncie la capacidad.

## Flujo E2E probado en disposable GitHub Actions
1. Usuario: consulta métodos, cotización geográfica y costo del servidor; geofence y método Stripe a domicilio son rechazados.
2. Usuario: POST /orders cash/delivery con `client_reference`, mismo ID en reintento, inventario descontado una sola vez, acceso protegido.
3. Restaurante: PATCH owner/orders/{id}/status en secuencia `received → confirmed → preparing → ready`.
4. Repartidor: verificado y conectado, `GET /driver/available`, aceptar, marcar `picked_up → on_the_way`, PIN y entrega.
5. PostgreSQL: `payment_status=paid`, `cash_collected=orders.total`, prueba de entrega y asiento `cash_delivery_collection` con idempotency key única y cobrador identificado; compensaciones y distribuciones permanecen pendientes de conciliación real.
6. Stripe LIVE y Connect no intervienen. La evidencia se crea en un PostgreSQL desechable en GitHub, no en producción.

## Checklist restante de NO-GO
- Tarifa real de ruta vial con un proveedor geográfico cuando sea requisito comercial; no denominar Haversine "distancia de manejo".
- Política de zonas, horarios, elegibilidad y asignación real del repartidor con capacidad operativa; disponibilidad online no garantiza aceptar cada pedido.
- Stripe TEST y LIVE a domicilio: creación de PaymentIntent, webhook firmado, transiciones y liquidación de repartidor sin considerar tarjeta como efectivo; cancelaciones/refundos bajo controles.
- Integrar app Usuarios v1.0.45, Restaurante y Repartidor contra el mismo runtime Kali en modo seguro. Android QA, FCM, privacidad de ubicación, permisos, promociones/rollbacks, restaurante real.
- Tarifas económicas, recaudación de efectivo y saldos por liquidar sólo son proyecciones: reconciliación efectiva y procesos de entrega/banco siguen manuales.
- Estado real de los servicios Kali, backups PostgreSQL LIVE/Redis, promociones PM2 y Stripe Connect: pendiente de verificar antes de ofrecer delivery públicamente.

**CI principal:** https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/40122807279 (PASS, PG15/Redis8 sólo sintético).
