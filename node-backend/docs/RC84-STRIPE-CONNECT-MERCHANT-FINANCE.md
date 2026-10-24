# Tala Eats RC8.4 — Connect, conciliación y dinero de restaurantes

**Estado: candidata de código, NO desplegada, NO cobros comerciales habilitados.**

## Modelo: Separate Charges and Transfers

Cada restaurante debe tener su propia cuenta Stripe Connect (MX) y completar la verificación de titular, banco/CLABE y condiciones en Stripe. Una cuenta Express del operador NO sirve para pagar a todos los comercios. La plataforma cobra una sola vez al comprador con PaymentIntent del pedido, y no considera el pago confirmado hasta registrar webhook firmado y ledger.

### Ejemplo de pedido para recoger

| Concepto | MXN |
|---|---:|
| Productos | 200.00 |
| Comisión de restaurante 15% | 30.00 |
| Servicio al comprador 7% | 14.00 |
| Cobro total al comprador sin propina | **214.00** |
| Pasivo del restaurante | **170.00** |
| Ingreso bruto de plataforma antes de Stripe y otros costos | **44.00** |

La tarifa Stripe efectiva debe leerse de Stripe Balance Transaction y contabilizarse como costo de plataforma: la estimación de procesamiento en pricing.ts NO prueba el cobro de la tarifa real. La propina no paga comisión. En pickup, una propina MXN 20 sumaría MXN 20 al cobro al cliente y MXN 20 al pasivo a favor del restaurante.

## Operación

1. ADMIN con MFA registra la asociación entre restaurante y cuenta Connect; se valida que el correo corresponda al propietario, y este la confirma desde su propia sesión. No se pueden asociar varias tiendas a la misma cuenta bajo la política piloto.
2. El propietario utiliza el enlace de onboarding de Stripe generado de forma efímera. Su retorno NO significa que esté verificado: el estado se consulta a Stripe tras finalizar.
3. Solo cuando Connect indique transfers ACTIVE, payouts habilitados, details_submitted y propietario aprobado se habilita el checkout para ese comercio.
4. Pedido confirmado por webhook LIVE + ledger immutable + entrega final y PIN/proof => propuesta de liquidación. Un pedido cancelado, reembolsado, disputado o no entregado se retiene.
5. Separa la responsabilidad de Stripe Transfer (plataforma a cuenta Connect) de Stripe Payout (cuenta Connect a cuenta bancaria). Una transferencia no significa depósito bancario.
6. Más adelante, al incorporar payout automático, se exigirá transferencia por cargo original, idempotency key por pedido, destino Connect específico, doble aprobación, límite, saldo disponible, reconciliación con Stripe y reversos. No se ha autorizado crear esa transferencia ahora.
7. Reembolso o disputa crea un caso duradero. Una notificación publicada no lo cierra. ADMIN revisa evidencia; otro ADMIN con MFA resuelve solo cuando Stripe confirma el estado compatible. Se bloquean cobros nuevos si existen eventos sin conciliar o incidentes abiertos.

## Código incorporado

- prisma/migrations/20261023_rc84_merchant_finance_controls/migration.sql: tablas de cuenta del vendedor, incidentes financieros y propuestas sin pagos automáticos.
- prisma/schema.prisma: modelos reflejados de la migración.
- src/live/merchant-finance-router.ts: endpoints protegidos para asociación, confirmación de propietario, onboarding, estado Connect, incidentes y propuestas read-only.
- src/live/financial-readiness.ts: controles que bloquean mientras haya incidentes sin resolver o recibos sin procesar.
- src/live/refund-reconciliation.ts, refund-failure-reconciliation.ts y dispute-reconciliation.ts: registran casos en una transacción junto al registro del evento.
- src/app.ts: verificación del cliente y Connect por restaurante ANTES de reservar un pedido de tarjeta LIVE.
- tests/rc84-merchant-finance.test.mjs y regresiones RC8 existentes.

## Restricciones de publicación

- La cuenta Connect inicial todavía no tiene payouts_enabled ni transfers activos, y los requisitos pendientes son de onboarding del vendedor.
- Stripe LIVE webhook actual requiere habilitar eventos de refund.created, refund.updated, refund.failed y charge.dispute.closed una vez verificada la versión desplegada.
- No desplegar en Kali hasta crear snapshot/restauración verificable de datos, completar migración de PostgreSQL de producción, comprobar usuarios/comercios y compatibilidad con la app Flutter publicada.
- Hacer una compra auténtica pequeña solo con autorización explícita; validar webhook firmado, pedido, ledger, estado de Flutter, conciliación y devolución completa o parcial, sin claves en logs.
- Solo entonces una única promoción de los procesos PM2 existentes y seguimiento de transacciones.
- Las transferencias y liquidaciones bancarias NO forman parte de esta candidata y requieren una segunda release con control real de fondos. Nunca tratar propuestas como transferencias.

**NO-GO comercial hasta aprobar pruebas reales y requisitos de Stripe Connect.**
