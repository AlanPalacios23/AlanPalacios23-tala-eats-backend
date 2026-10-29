# RC12.6 — Puerta de calidad ANTES de incorporar comercios reales

**No se necesita que The Burger House (ni otro negocio de prueba) tenga permisos comerciales para certificar el backend.** Un sistema vacío antes de abrir al público es un estado normal. Eso no debe confundirse con permitir cobros: cada pedido real exige dueño aprobado, tienda disponible, Connect propio y capacidad logística según el modo.

## Contrato de incorporación
1. Cuenta customer nueva -> POST /api/v1/operations/onboarding con tipo restaurant o driver, datos reales y documentos propios.
2. ADMIN con MFA revisa solicitud -> PATCH /api/v1/operations/admin/onboarding/:id, sin escribir directamente banderas de verificación en PostgreSQL.
3. Usuario vuelve a iniciar sesión tras recibir nuevo rol. El mismo usuario no puede intercambiar roles restaurant/driver por una nueva solicitud.
4. Comerciante configura dirección/ubicación, menú, stock y horarios; ADMIN asigna una cuenta Stripe Connect distinta de la plataforma; titular confirma la vinculación y KYC.
5. Driver aprobado configura vehículo/placa, se conecta, emite GPS fresco y recibe ofertas solo sin entregas activas.

## Pruebas de aceptación (sin clientes LIVE)
| Modo | Prueba obligatoria antes del primer comercio real |
|---|---|
| Pickup efectivo | Alta -> pedido idempotente -> cocina -> PIN -> ingreso físico contabilizado, sin crear crédito bancario Stripe |
| Pickup tarjeta | PaymentIntent TEST -> webhook firmado -> ledger -> cocina y entrega -> reembolso/fallo/reintento |
| Domicilio efectivo | GPS realista fresco -> oferta única -> restaurante READY -> recoge -> PIN -> cobro y deuda de efectivo conciliados |
| Domicilio tarjeta | Stripe TEST firmado con modo delivery -> dispatch -> PIN -> split exacto -> cancelación, devolución y disputa |
| Retiros y liquidaciones | Connect por beneficiario, saldos realmente transferidos, step-up, doble aprobación, transfer/payout idempotentes y webhooks externos |
| Operaciones | 3 PWAs con sesiones reales, notificaciones, colas, alertas, restauración aislada y rollback |

Las pruebas CI del repositorio que crean pedidos ficticios están deliberadamente limitadas a GitHub Actions y PostgreSQL/Redis DESECHABLES. **Nunca se ejecutan contra tala_node_live.** Su PASS NO prueba por sí solo un webhook de Stripe TEST externo ni un payout bancario.

Comprobaciones disponibles: `npm run verify`, `tests/rc126-pre-onboarding-gates.test.mjs`, `.github/workflows/tala-node-cash-pickup-atomic-e2e.yml`, `.github/workflows/rc87-delivery-cash-full-e2e.yml`, `.github/workflows/rc810-synthetic-paid-delivery-e2e.yml`, `.github/workflows/rc9-node-treasury-safe.yml`.

## Dos resultados diferentes

- **BACKEND TÉCNICAMENTE CERTIFICADO:** registro/aprobación, cuatro pagos y logística, conciliación, recuperaciones y controles de seguridad pasan E2E en TEST aislado, con pruebas de fallos. No depende de comercios de prueba registrados en LIVE.
- **PILOTO COMERCIAL AUTORIZADO:** además, un negocio real aprobado, un driver real disponible, cuentas Connect verificadas, prueba financiera controlada y operación humana preparada.

RC12.6 solo endurece la consistencia de los roles de alta y añade pruebas unitarias sobre aceptación sin negocios preexistentes. **No declara el backend terminado; no modifica producción, credenciales ni libera ningún cobro o retiro.**