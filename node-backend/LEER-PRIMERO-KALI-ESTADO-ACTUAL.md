# LEER PRIMERO — Tala Eats Node/Kali (estado al 29-oct-2026)

**Documento de continuidad entre conversaciones:** [`docs/RC128-KALI-3PWA-LIVE-STAGE-HANDOFF-20261029.md`](docs/RC128-KALI-3PWA-LIVE-STAGE-HANDOFF-20261029.md).

## Cinco hechos que no hay que confundir

1. **LIVE real = `127.0.0.1:18190`**, dos procesos PM2 online con SHA fijo `1562827129b90094bce90cca3647c57d94e33fcc` (RC12.8). Las PWA públicas Clientes `18195`, Restaurantes `18197` y Repartidores `18199` tienen proxy a LIVE. `18196` es una vista previa conectada a LIVE, **no** staging.
2. **STAGING paralelo = `127.0.0.1:18192`**, PostgreSQL 15.19 `127.0.0.1:15435/tala_node_stage` y Redis DB1; las PWA locales de prueba `18205/18207/18209` dieron HTTP+API PASS. No son otra versión productiva ni un E2E aprobado.
3. **Driver LIVE ya existe**: un driver verificado, online y con GPS fresco; no re-registrarlo ni mover su identidad a staging. **Las banderas de entrega/dispatch LIVE y las transferencias Connect LIVE están apagadas.**
4. **Formulario driver STAGING bloqueado con causa concreta:** GET `/api/v1/operations/onboarding-capabilities` en 18192 devuelve **404 not_implemented**, aunque el código fuente RC12.8 contiene la ruta; se desconoce el SHA/`dist` exacto del PM2 paralelo. NO habilitar artificialmente inputs; el operador decidió dejar esta tarea en pausa.
5. **Stripe TEST no prueba payout real todavía:** migraciones de stage 3/3 PASS; receptor de firma local PASS, Connect TEST 0 cuentas, sin orden entregada ni payout TEST remoto. No confundir HMAC local con evento Stripe externo ni `ready=true` con un lanzamiento financiero.

## Orden de trabajo acordado

**Primero corregir/terminar las tres PWA LIVE y backend de pedido completo**: cliente elige/paga → restaurante recibe/acepta/prepara/READY → repartidor recibe/recoge/entrega con PIN → Wallet/ledger concilia.

Después validar con **Stripe TEST real** las piezas financieras de entrega y retiros; solo con evidencias y aprobación independiente considerar liberar banderas LIVE. No alterar `STRIPE_CONNECT_TRANSFERS_ENABLED=false` o las banderas LIVE de domicilio como atajo. No volver a reconstruir Nginx o repetir la PWA estática STAGING sin motivo.

**Diagnóstico y precauciones, historial exacto, procedimientos y próximos pasos:** ver el [handoff completo](docs/RC128-KALI-3PWA-LIVE-STAGE-HANDOFF-20261029.md). Su información es una instantánea fechada, no sustituye una comprobación nueva antes de un despliegue.

> Esta actualización es **solo documentación**; no cambia rutas, despliegues, DB, configuración de pagos ni los servicios en Kali.
