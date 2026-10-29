# RC11.4 — Plan de cutover LIVE, sin simulaciones (2026-10-28)

## Objetivo y alcance
Habilitar un servicio comercial real entre las PWA Cliente, Restaurante y Repartidor, con el backend Node existente. La existencia de rutas de backend NO constituye prueba de funcionamiento comercial. RC11.2/RC11.3 quedó instalado en el SHA `c8eb3f656e83f88f2bcbd56846405068b0f407d8`, pero sus tres interruptores de domicilio efectivo están OFF. RC11.4 corrige el contrato de capacidades; no habilita tarjeta a domicilio ni retiros.

## Gates bloqueantes
1. Obtener SHA exacto HEAD de la rama RC11.4; consultar CI del SHA (compilación, tests integración PG/Redis, seguridad, rutas, finanzas). Sin PASS inequívoco: HOLD.
2. Verificar en Kali la identidad de los dos PM2 contra el SHA desplegado: ambos deben usar la MISMA carpeta y estar online. Verificar `/api/v1/ready` por loopback y por Cloudflare, Redis worker, backups y posibilidad de rollback.
3. Desplegar RC11.4 **solo código**, con los tres `LIVE_DELIVERY_CASH_*` OFF y `LIVE_DELIVERY_CARD_CHECKOUT_ENABLED`, `LIVE_DELIVERY_DISPATCH_ENABLED`, `LIVE_DELIVERY_RELEASE_APPROVED`, `STRIPE_CONNECT_TRANSFERS_ENABLED` OFF. No modificar .env, DB, Stripe, ni PWA en este paso.
4. Prueba de regresión autenticada de `GET /api/v1/orders/payment-methods`: con flags OFF, `delivery_checkout_supported`, `delivery_cash_supported`, `delivery_quote_supported` y `delivery_stripe_supported` son false. Pickup LIVE sigue operando.
5. Ejecutar `rc114-kali-live-cash-readiness.mjs` bajo usuario tala-node-stage con SHA fijado y entorno LIVE protegido. HOLD si no hay comercio real verificado/abierto con domicilio y driver autorizado, libre con GPS reciente. Resultado positivo es capacidad logística, no pago probado.
6. Verificar que las tres PWAs conectan al mismo API LIVE: autenticación, catálogo/stock, dirección y cotización, creación de pedido idempotente, restaurante recibe/acepta/prepara/listo, driver recibe oferta/acepta/recoge, cliente ve seguimiento, entrega con PIN y contabilidad de cobro cash. Auditoría de doble toque, cancelaciones, reintentos, pérdida de red, PIN equivocado, saldo del driver y saldo del comercio.
7. **Solo tras evidencia E2E real** y autorización operativa separada, habilitar juntos los tres flags de cash delivery en el procedimiento específicamente revisado; no habilitar uno por uno ni ejecutar pruebas con compradores no informados. Verificar fail-closed y rollback de configuración.
8. **Tarjeta domicilio LIVE = HOLD** hasta PaymentIntent delivery auténtico, verificación de webhooks firmados, exactamente una contabilización por cargo, reembolsos/disputas, manejo de fallo y reconciliación. **Retiros LIVE = HOLD** hasta fondos disponibles en Stripe Connect, reserva, idempotencia, autorización, estado externo y conciliación. Ninguna de estas funciones se habilita con flags aislados.

## Precaución sobre instalador RC11.3
El script `rc113-kali-live-cash-delivery-cutover.sh` valida que NO exista `~/.config/rc113-cash-delivery-previous.json` antes de `--apply`. Como RC11.3 ya fue instalado, **es probable que exista ese recibo de rollback**. NO borrarlo, NO editarlo y NO volver a ejecutar `--apply` para RC11.4 sin adaptar y probar antes un instalador RC11.4 con recibo propio y rollback correcto. Antes de autorizar una actualización real, confirmar también la identidad del SHA desde Kali; el historial de PR no reemplaza esta comprobación.

## Dictamen
RC11.2/RC11.3: entrega de código cerrada. RC11.4: despliegue de código condicionado a CI y preflight. Comercial efectivo domicilio: HOLD hasta E2E. Tarjeta domicilio y retiros: HOLD hasta integraciones verificadas. No declarar LIVE funcional solamente porque `/ready` devuelve true.
