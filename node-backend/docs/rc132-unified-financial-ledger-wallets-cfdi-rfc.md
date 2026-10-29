# RFC RC13.2 — Núcleo financiero único, facturación por concepto y Wallets verificables
**Tala Eats · diseño de operación, 29/oct/2026 · piloto objetivo 08/nov/2026 · PROPUESTA, NO IMPLEMENTADO**

## 0. Decisiones y límites innegociables

1. El backend Node.js / PostgreSQL mantiene la **única fuente de verdad monetaria**; las PWA Clientes, Restaurantes y Repartidores, y ADMIN, son vistas de permisos del MISMO registro. Ninguna app calcula comisiones, retenciones, disponibilidad o banco a partir de cifras propias.
2. Distinguir cinco estados diferentes: **pedido/venta**, **dinero autorizado/capturado**, **custodia física**, **obligación por pagar/cobrar**, **dinero disponible/liquidado en banco**. Nunca traducir `paymentStatus='paid'`, un ticket, un PIN o un screenshot a dinero transferido.
3. **La facturación comercial NO equivale a CFDI fiscal**. Un pedido puede producir recibo comercial, uno o varios CFDI emitidos por participantes legalmente distintos, documento de comisión/servicio, y recibo/estado semanal por repartidor. Nunca generar CFDI de productos o reparto a nombre de Tala Eats sin confirmar quién es el prestador y el emisor fiscal legítimo.
4. **Conductor NO retiene la paga del efectivo cobrado al cliente**. Si un driver Tala Eats toca efectivo en domicilio, primero queda en custodia transitoria individual; solo con **doble acuse autenticado e importe verificado** se registra como caja del restaurante. Sin handoff real confirmado -> HOLD entrega en efectivo. Alternativa: reparto propio del negocio.
5. Retenciones fiscales, tasas IVA, CFDI por servicio, relación laboral, fechas legales y tratamiento de cargos deben configurarse desde reglas aprobadas por asesor fiscal/laboral para la entidad real. La tarifa comercial vigente (15% / 7% / $39 base / $32 driver) NO establece por sí sola tratamiento IVA/ISR.
6. Las cuentas Connect autorizadas y un cobro Stripe capturado no equivalen a una transferencia Connect ejecutada ni a un abono bancario; nunca mezclar `cash_due_platform` con `stripe_available`.
7. Producción LIVE no cambia al aceptar este RFC; flags de cash delivery, card delivery, transfers y withdrawals siguen con sus gatekeepers actuales. No reescribir el historial de pagos.

## 1. Hallazgos concretos en RC12.8 (SHA 1562827129b90094bce90cca3647c57d94e33fcc)

**Ya existe**:
- `src/live/rc85-commercial-policy.ts`: desglose servidor de precios, comisión, servicio, envío y pago de repartidor en centavos.
- `src/marketplace/checkout.ts`: reserva stock, pedido idempotente y validaciones LIVE.
- `src/live/webhook-inbox.ts`: inbox duradero de eventos Stripe firmados, deduplicados, reprocesamiento.
- `prisma/schema.prisma` `financial_ledger_entries`: movimientos por cuenta y clave única, `tala_live_payee_allocations`: obligaciones restaurante/driver, `tala_live_cash_custody`: custodio, `tala_live_treasury_*`: tesorería específica para transferencias/retiros.
- `src/live/payee-finance-router.ts`: historial de ganancias, preparación de obligaciones, comprobante de cash y revisión ADMIN, SIN liquidación cash bancaria verificada.
- `src/live/treasury-policy.ts`: retirables de Connect únicamente desde fondos disponibles y transferencias conciliadas; retirada LIVE bloqueada.
- PWA Restaurante `src/components/MerchantWallet.tsx`: ventas y pagos históricos, modal retiros bloqueado. PWA Driver `src/components/DriverPwaWorkflow.tsx`: ganancias del día y últimas 7 jornadas, no recibo de nómina ni informe por entrega con retenciones. PWA Clientes `CustomerOrders.tsx`: detalles y estado, no motor fiscal completo.

**FALTANTE / desacople crítico**:
- Los actuales registros `financial_ledger_entries` y `tala_live_treasury_ledger` son proyecciones contables por tipo; **NO consta aún un libro general de partida doble que iguale débitos y créditos en cada transacción de todos los medios**. No afirmarlo por nombre `ledger`.
- `src/live/payee-allocation.ts`, en cash delivery con reparto de plataforma, asigna al conductor como cobrador y retenedor. Contradice la política actual merchant-first.
- No hay fuente autorizada unificada de **cuentas fiscales/emisores CFDI por concepto**; no existe emisión fiscal automática comprobada ni PAC certificado conectado en el recorrido actual.
- No existe cierre semanal formal unificado de restaurante+repartidor con versionado, saldo anterior, todas las devoluciones tardías, descuentos, evidencias y conciliación externa bancaria.
- No existe conciliación bancaria del cash suficiente para afirmar `settled` desde un comprobante de depósito o una foto.

## 2. Sistema de dinero: un identificador y eventos verificables

Cada compra y cada envío tendrá:
- `order_id` inmutable; `delivery_id` o referencia de envío, `restaurant_id`, `driver_user_id`, `buyer_id`; referencia idempotente `client_reference`.
- `pricing_snapshot` en centavos: lista de productos, descuentos, impuestos por concepto aprobados, 15% comisión, 7% fee cliente, envío base o tarifa aprobada, propina, redondeos, pagador/beneficiario de cada cargo; **aprobación servidor antes del cobro**.
- `payment_id`, proveedor y `provider_object_id` para tarjeta (nunca guardar PAN/CVV); `cash_custody_id` en efectivo.
- `financial_event_id` único e idempotente: autor, tipo, fuente, fecha, firma/recibo cuando aplique.
- `invoice_issuer_key` y `fiscal_role` por concepto: comercio, plataforma, proveedor de entrega, nómina/prestador, determinado por reglas fiscales vigentes.
- `settlement_batch_id` y `bank_reference` para el cierre real; movimientos en HOLD por eventos faltantes.
- Todas las cantidades expresadas en **centavos int64/bigint MXN**, nunca floats JS. Correcciones con asiento compensatorio, no UPDATE/DELETE de historia.

## 3. Nuevo libro general de PARTIDA DOBLE (migra aditivamente)

Propuesta tablas **nuevas**, sin modificar/duplicar automáticamente transacciones anteriores:

| Tabla | Propósito y controles |
|---|---|
| `finance_accounts_v2` | Cuenta por moneda: Stripe en tránsito, Stripe disponible, caja del restaurante, caja en tránsito bajo conductor, banco de Tala Eats, comisión plataforma, servicio, envío, cuentas por pagar a comercios y conductores, cuentas por cobrar a comercios, procesamiento Stripe, impuestos/retenciones, ajustes. Identidad y permisos de consulta. |
| `finance_journals_v2` | Un evento financiero confirmado, fuente, timestamp, monto, idempotency_key UNIQUE, correlation_id, version, reversal_of y referencia proveedor. Nunca editable después de POSTED. |
| `finance_postings_v2` | N partidas por diario, account_id, debit_minor, credit_minor; **suma débito = suma crédito por moneda y journal**, comprobado transaccionalmente en servicio y DB, sin ceros/negativos ilegales. |
| `finance_provider_events_v2` | Registros externos firmados/deduplicados Stripe/Connect/banco; state RECEIVED, RECONCILED, HOLD; alias a tablas existentes, no duplicar webhook como cobro. |
| `cash_custody_transfers_v2` | Pedido, custodio previo, custodio nuevo, monto íntegro esperado/recibido, doble consentimiento, no se permite handoff del mismo efectivo 2 veces, estado IN_TRANSIT/ACKNOWLEDGED/MISMATCH/EXCEPTION. Solo dominio cash. |
| `finance_obligations_v2` | Devengos/restaurante/conductor, saldo acreditado contra journal, HOLD, AVAILABLE, RESERVED, PAID, REVERSED, tax status; no crea fondos por sí misma. |
| `finance_settlement_batches_v2` + `finance_settlement_lines_v2` | Restaurante o conductor, periodo local, reglas aplicadas, snapshot hash, renglones pedidos/envíos/ajustes, estado PREVIEW/FROZEN/REVIEWED/APPROVED/SUBMITTED/RECONCILED, índices UNIQUE contra doble corte. |
| `finance_invoice_cases_v2` | CFDI/recibo independiente, issuer, recipient, facturable_role, items_tax_snapshot, fiscal_status REQUESTED/PENDING_PAC/STAMPED/CANCELLED/REPLACED/ERROR, PAC UUID, XML/PDF cifrado/privado, relación a pedido y línea. |
| `finance_reconciliation_v2` | Conciliación Stripe/banco/caja/ledger con diferencia, evidencia autorizada, caso, SLA, responsable y result RELEASED/HOLD/EXCEPTION. |
| `driver_work_sessions_v2` | Registro de asignaciones, tiempos activos/espera y jornadas para recibo semanal y cumplimiento laboral, con privacidad. |

**Regla por actualización:** en una transacción PG colocar *pedido/cambio + snapshot + journal POSTED + outbox*; consumidores reintentan idempotentemente. Un evento Stripe es prueba externa tras validar firma y objeto específico, no se confirma como cobro por la PWA. La conciliación del banco necesita comprobación externa, no screenshot.

**Invariantes automáticas:** sum(debit)=sum(credit) por journal y moneda; `customer_total=restaurant_entitlement+driver_entitlement+platform_gross` según contrato y tratamiento de impuestos; custodias cash de un billete solo cambian de tenedor (no crean ingresos otra vez); `available <= captured_reconciled - disputed/refunded/holds`; un pedido no se factura dos veces con un mismo emisor/concepto; un devengo no se liquida dos veces.

## 4. Ciclo de una compra / entrega

| Etapa | Qué sabe de verdad el backend | Efecto en Wallet |
|---|---|---|
| 1. Cotización | Productos, modalidad, desglose y TTL aprobados; NO cobrado. | Vista previa, no ingreso. |
| 2. Pedido confirmado | Pedido idempotente y reserva inventario (si corresponde). | `PENDIENTE`, no dinero disponible. |
| 3a. Tarjeta | PaymentIntent creado, luego evento firmado+conciliación de captura. Stripe disponible solo cuando proveedor lo confirme. | `CAPTURADO / EN TRÁNSITO / DISPONIBLE`, nunca mezclar. |
| 3b. Efectivo | Pedido pagadero al recibir; momento real y custodio explícito. | `PENDIENTE DE COBRO`, luego `CUSTODIA`. |
| 4. Cocina/entrega | Restaurante aceptó/preparó; conductor asignado/recogió/entregó con PIN. | Devengo contabilizado por evento de cumplimiento, **no** solo por el pago inicial. |
| 5. Handoff cash | Conductor entrega TODO al comercio, doble confirmación y cifra exacta. | `EN TRÁNSITO` hasta acuse, luego `CAJA COMERCIO`. Sin acuse -> HOLD. |
| 6. Ajustes | Reembolso, devolución, incidencia, disputa, diferencia de caja, comisión proveedor. | Asiento nuevo inverso/correctivo, nunca reescribir. |
| 7. Corte | Snapshot semanal, obligaciones elegibles y deudas cash comprobadas, revisión. | Ganado, retenido, recibido en efectivo, tarjeta a liquidar, deuda y neto. |
| 8. Liquidación | Stripe transfer/payout o SPEI **real** con referencia y reconciliación. | Solo entonces `TRANSFERIDO / EN BANCO`. |
| 9. Fiscal | Emisión/cancelación CFDI y comprobante de retenciones cuando corresponda. | Documentos descargables, estado de timbrado independiente del dinero. |

Cada etapa debe registrar `order_id`, `event_key`, actor, tiempo del servidor, origen del hecho y evidencia; no almacenar detalles bancarios completos ni exponer datos fiscales ajenos.

## 5. ¿Quién factura cada compra y envío? Definir emisor legal, no por pantalla

**La orden comercial puede generar VARIOS documentos fiscales, no forzosamente un único CFDI**:
- **Productos del restaurante:** si el restaurante es vendedor/merchant of record, el comercio emite CFDI de productos al comprador o el correspondiente CFDI global conforme a su régimen. Tala Eats solo puede ofrecer **emisión delegada autorizada** mediante su PAC si el comerciante contrató ese servicio, nunca emitir con RFC de Tala Eats indebidamente.
- **7% tarifa al cliente y 15% comisión al negocio:** son servicios potencialmente facturables por Tala Eats a los receptores reales. Determinar si tarifas incluyen IVA, su base y receptor antes de desplegar calculadora fiscal. Distinguir recibo del servicio, CFDI de comisión y retenciones aplicables.
- **$39 envío cobrado al cliente y $32 pago al driver:** el CFDI del envío debe seguir a la entidad que **jurídicamente presta/vende la entrega**, no asumir que es el driver o el restaurante; depende del contrato de servicio. Se requiere registrar `delivery_service_issuer` por modalidad. El pago al repartidor es otra obligación distinta y **no una segunda venta al cliente**.
- **Repartidores:** la Ley Federal del Trabajo, art. 291-K, obliga a la plataforma que actúa como patrón a pago en plazo no mayor a semana, recibo semanal por tarea y tiempo, y transparencia. Determinar clasificación laboral y fiscal; si corresponde nómina, emitir **CFDI nómina** y cálculo de retenciones/IMSS; si prestador independiente y legalmente procedente, documentar con CFDI de su servicio y retenciones. **NO pedirle un CFDI de honorarios por defecto solo porque utiliza una app**.
- **Plataforma de intermediación:** evaluar CFDI de retenciones/información de pagos con Complemento Servicios Plataformas Tecnológicas, ISR/IVA y declaraciones informativas según modelo real, titular y régimen del participante. No fijar porcentajes fiscales en código sin revisión de contador.
- **CFDI 4.0:** RFC, nombre/razón social, CP fiscal, régimen, uso CFDI, método y forma de pago, conceptos e impuestos; timbrar con PAC/SAT y guardar UUID/XML/PDF y estados. Diferenciar PREPARADO del STAMPED externo. Reembolsos y cancelaciones requieren proceso fiscal separado (egreso/cancelación/sustitución según caso).
- **Privacidad:** RFC y datos fiscales cifrados/en control de acceso, facturas ajenas nunca en APIs públicas; nómina/retenciones particularmente restringidas. No guardar certificados de sello digital o contraseñas en GitHub, frontend o logs.

Referencias oficiales para validación fiscal/laboral antes de emitir:
- https://www.sat.gob.mx/minisitio/Factura/emite_quenecesitoparafacturar.htm
- https://wwwmatnp.sat.gob.mx/consulta/52846/complemento-servicios-de-plataformas-tecnologicas
- https://wwwmatnp.sat.gob.mx/articulo/05058/articulo-113-a
- https://wwwmat.sat.gob.mx/declaracion/87721/presenta-tu-declaracion-informativa
- https://www.ordenjuridico.gob.mx/Documentos/Federal/html/wo125151.html
- https://www.imss.gob.mx/empresas-personas-trabajadoras-plataformas-digitales

## 6. App Restaurante: Wallet completo, no portal externo

En `Wallet` pantalla principal:
- **Ventas brutas** por periodo; **ganancia del comercio** tras comisión (sin llamar ganancia neta fiscal), **efectivo real en su caja**, **cobros Stripe pendientes**, **fondos disponibles**, **deuda por comisión y delivery**, **saldo neto semanal**, **disputas/retenciones**, **transferencias realmente pagadas**.
- Filtros Hoy, Semana, Mes, por método (4 modos), por estado, y por orden/entrega.
- `Pedidos y detalle`: conceptos desglosados, evento que soporta cada cantidad, referencia de entrega y conciliación, PDF/CSV.
- `Facturación fiscal`: CFDI emitidos/pendientes, solicitudes del cliente y autorizaciones delegadas cuando legalmente correspondan, descarga XML/PDF con RFC oculto fuera del perfil correspondiente.
- `Liquidación semanal`: desglose por orden, saldo anterior, deuda efectivo, neto a favor o en contra, casos abiertos, fecha de corte, transferencias con recibo bancario; objeción/soporte; cerrar con doble revisión. **Nunca ocultar deudas porque se muestren ganancias.**
- La pantalla `Retirar ganancias` muestra habilitación real solo si existe saldo probado en Connect; compensación weekly y transferencias bancarias **no se convierten automáticamente en saldo Connect**.

## 7. App Repartidor: Wallet de cada envío y recibo semanal

- `Cada entrega`: fecha/hora, tarifa base $32, suplemento autorizado, propina íntegra, ajustes/reembolsos justificados, importe bruto devengado, retenciones legales si aplican, neto a cobrar, estado comprobable de pago.
- `Ganancias` Hoy/Semana/Mes: completadas, pendientes, retenidas por incidencia, devengadas, netas, pagadas y saldo pendiente de pago. Nunca inventar disponible bancario.
- `Recibo semanal` con total de entregas, tiempo trabajado y en espera, conceptos pagados, retenciones y referencia de pago; integrar obligaciones LFT/IMSS sin asumir que todos son autónomos ni usar recibo comercial como CFDI.
- `Efectivo en tránsito`: cuando el cliente paga cash a domicilio, **no es sueldo del driver**. Mostrar importe recibido del cliente, custodio, destinatario, estado de handoff, doble confirmación con negocio, discrepancias. No permite `Retirar` de ese efectivo ni descontarlo silenciosamente de sueldo.
- `Pagos` y `Documentos`: transferencia, recibo legal/fiscal emitido por sujeto correcto, comprobante de pago y bloqueos. Datos fiscales solo propios.

## 8. Cliente y ADMIN

**Cliente PWA:** pedido con desglose aprobado por servidor, cargo único, seguimiento, comprobante de pago; `Solicitar factura` por emisor/concepto legal; descarga CFDI timbrado si existe, cancelación/reembolso con estado verificado. No generar CFDI por mostrar recibo.
**ADMIN financiero:** visión consolidada sin acceso irrestricto a secretos; cada peso: qué pedido, dónde está, custodio, dueños de obligación, último webhook/recibo, estado fiscal, antigüedad y motivo HOLD; monitor de caja y entregas, conciliación Stripe/Cash/SPEI, transferencias/payouts, discrepancias, impuestos/retenciones, semanas, alertas y doble aprobación.

## 9. API y control de acceso (contratos NUEVOS propuestos, NO EXISTENTES)

- `GET /api/v1/owner/wallet/overview?period=...`, `GET /api/v1/owner/wallet/statement/:periodId`, `GET /api/v1/owner/wallet/order/:orderId`, `GET /api/v1/owner/wallet/statement/:periodId/export?format=csv|pdf`.
- `GET /api/v1/driver/wallet/overview?period=...`, `GET /api/v1/driver/wallet/earnings/:deliveryId`, `GET /api/v1/driver/wallet/weekly/:periodId`, `GET /api/v1/driver/wallet/cash-in-transit`.
- `POST /api/v1/driver/cash-handoff/:orderId/initiate`, `POST /api/v1/owner/cash-handoff/:orderId/confirm`, `GET /api/v1/admin/finance/cash-handoffs`. Requerir identidad/rol de ambas partes, replay guard, límites y evidencia.
- `POST /api/v1/customer/orders/:orderId/invoice-request`, `GET /api/v1/customer/orders/:orderId/invoices`, `GET /api/v1/owner/invoices`, `GET /api/v1/driver/weekly-receipts`. No emitir hasta seleccionar PAC y validar emisor fiscal.
- `GET /api/v1/admin/finance/reconciliation`, `GET /api/v1/admin/finance/ledgers/:orderId`, `POST /api/v1/admin/finance/settlements/:periodId/review`, `.../approve`. Doble control, RBAC ADMIN y MFA. Idempotency-Key obligatoria en operaciones que muevan estado.

**Latencia objetivo:** API muestra estados operativos tras commit, un webhook Stripe se refleja al recibir/conciliar; banco solo tras conciliación verdadera, aunque tarde horas/días. Si faltan fuentes externas, mostrar `PENDIENTE DE CONFIRMACIÓN`, nunca un total estimado como `disponible`.

## 10. Implementación con gates 8 nov 2026

**P0 · Antes de abrir cualquier cobro LIVE:**
1. Congelar SHAs compatibles, restaurar restaurante/stock, revisar outbox; respaldo y rollback.
2. Hacer mapa exhaustivo de movimientos existentes y evitar doble contabilización en migración v2.
3. Implementar esquema aditivo de journal v2 y adapters de cargos + efectivo/pickup/delivery + compensación con invariantes transaccionales. Pruebas 4 modalidades, red, reintentos, duplicados, reversals.
4. Wallet restaurante/driver conectado a extractos de servidor, distinguir venta/devengado/pendiente/held/pagado; vista por pedido y resumen semanal PRELIMINAR/CONTROLADO. Registro por envío.
5. Cash entrega domicilio: cadena de custodia REAL o **NO-GO** cash-delivery conductor plataforma.
6. Stripe TEST webhooks externos, receipts y reversión, luego LIVE canary con permiso. No liberar Connect Transfers/Retiros mientras faltan auditorías.
7. Cierre y revisión diaria + primer corte semanal reproducible; auditor independiente de sumas y estados; soporte/incidentes con fallback a no admitir nuevos pedidos.
8. **Contabilidad legal fiscal:** confirmar entidad contratante, calidad de intermediario/merchant of record, emisores CFDI, productos gravados, forma de comisión, estatus laboral y retenciones con profesional competente, antes de emitir facturas fiscales.

**P1 · Posterior al piloto / solo cuando fiscalmente preparado:**
- PAC/SAT timbrado CFDI 4.0, complemento retenciones, nómina, egresos/cancelaciones, delegación, y CSV/PDF fiscales; validar con contador y test de PAC. Los estados de cuenta PDF/CSV comerciales sí pueden comenzar antes si se etiquetan correctamente.
- Automatizar conciliación banco SPEI, cortes semanales, disputa y pago; retiro Connect tras transferencia real y MFA, verificando saldo bancario externo.
- Completar fiscal laboral STPS/IMSS y controles de privacidad; no usar funcionalidad fiscal aparente como sustituto del cumplimiento.

## 11. Gates de aceptación medibles

- 0 publicaciones desequilibradas; cada journal v2, debits = credits, y cada suma por pedido conserva centavos sin diferencias.
- 0 duplicados en callbacks/webhooks/reintentos; no se paga dos veces al mismo beneficiario, no se emite dos veces CFDI del mismo emisor/concepto.
- 100% de pedidos LIVE completados tienen trazabilidad de cobro/pasivo/custodia/beneficiario; partidas sin prueba externa en HOLD.
- 100% de entregas a domicilio tienen monto de driver devengado y comprobante de entrega; 100% cash COD de driver Tala Eats cuenta con handoff completo antes de aparecer en caja de comercio.
- 100% de pagos finales registrados muestran referencia real Stripe/banco con reconciliación, sin llamar `LIQUIDADO` a `SUBMITTED`.
- Cierre semanal del comercio = saldo inicial + movimientos elegibles + ajustes − liquidaciones; siguiente semana abre exactamente con el saldo final previo.
- PWA Restaurante y PWA Driver muestran exactamente las mismas cantidades financieras que API/ADMIN para cada operación que les corresponde, con permisos y privacidad.
- CFDI fiscal solo se marca `TIMBRADO` cuando hay UUID y respuesta verificada PAC, emisor autorizado y requisitos completos; los demás reportes se llaman `estado de cuenta`.
- No habilitar el piloto por el calendario si falta la cadena de custodia o las pruebas de cuatro modos.

## 12. Referencias y entregables

Complementa y reemplaza partes del plan de facturación semanal `docs/rc131-weekly-restaurant-settlement-policy.md`: RC13.1 es una calculadora de lectura y propuesta merchant-first; **no** hay aún contabilidad unificada ni CFDI timbrados. Registrar implementación por fases vinculadas a issue principal #196 y PR #197. Los cambios de implementación requieren nuevo gate de migración y pruebas en Kali.

**Documento RFC. No genera facturas, realiza pagos, hace transferencias ni despliega código.**
