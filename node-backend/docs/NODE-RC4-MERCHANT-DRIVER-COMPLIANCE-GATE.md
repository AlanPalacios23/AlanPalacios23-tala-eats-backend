# Tala Eats Node.js · RC4 — Catálogo, comercio y Repartidor verificados

Estado: **STAGING QA ONLY**. Ni el backend Python ni Stripe, ni Kali se actualizan mediante este cambio.

## Correcciones funcionales incluidas
- `GET /api/v1/restaurants` y `GET /restaurants/:id`: solo restaurantes con verificación `verified`, incluso si `is_open=true`. Se aplica antes de `market_code`, LIMIT y OFFSET. Tiendas cerradas pero verificadas pueden seguir listadas conforme al contrato actual.
- Favoritos y recomendaciones: ocultan comercios no aprobados.
- `POST /api/v1/orders` cash/pickup sintético: valida el mismo estado dentro de la transacción con locks; un comercio suspendido no descuenta stock ni crea ledger, aunque conservara `is_open=true`.
- Owner: no puede cambiar a abierto si la tienda no está verificada. Puede seguir preparando menú y perfil.
- Moderación: `pending/rejected/suspended` cierran la tienda, quitan patrocinio y deshabilitan ingreso de pedidos. Las decisiones sobre onboarding existentes actualizan el restaurante o el perfil del repartidor en la misma transacción; al reaprobar el comercio continúa cerrado hasta que el dueño lo abra.
- Repartidor: una nueva cuenta creada mediante la API de perfil empieza con `is_verified=false`. No puede declararse online ni recibir ofertas hasta que ADMIN la verifique, incluso bajo el flag sintético D2.

## Pruebas de integración
- E2E PostgreSQL 15 + Redis 8: ocultar tienda suspendida, validar mercados y paginación, impedir checkout con verificación revocada, conservar stock, denegar apertura Owner.
- E2E G1: suspensión y posterior aprobación con la tienda cerrada.
- E2E D2: nuevo perfil sin aprobación recibe 403 al iniciar turno y no recibe ofertas, pero un perfil verificado supera el recorrido sintético de entrega.
- CI general verifica autenticación, catálogo, stock/idempotencia, contraejemplos de pagos y migración anterior RC2. Tests sintéticos **no equivalen a entregas reales**.

## Limitaciones y próximos pasos
- El esquema legado conserva `driver_profiles.is_verified DEFAULT true` en PostgreSQL, mientras que **todas las rutas de creación de perfil Node** establecen ahora `false` explícitamente. Una migración revisada para cambiar el DEFAULT a FALSE y auditar filas antiguas será necesaria antes de despliegue comercial. No alterar datos históricos silenciosamente.
- Google/Email recovery: proveedor y enlace móvil aún sin validación real.
- Entregas: aún solo fixtures D2; hay que implementar el circuito comercial real y revisar órdenes, GPS, KDS y cartera.
- Stripe: bloqueado; requerirá test mode, webhooks, conciliación y liquidaciones verificadas antes de habilitar dinero.
- RC2 contiene migración de soporte pendiente en Kali; esta rama no añade otra. No ignorar los respaldos, restauración y revisión SQL del runbook RC2/RC3.
- `ready=true` no equivale a autorización de producción. Se requiere QA real de las tres apps en teléfonos y aprobación explícita de release.

Ningún proceso de GitHub Actions aquí instala en Kali ni toca producción Python.
