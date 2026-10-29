# RC13.1 — Estado semanal de cuenta y liquidación neta por restaurante

**Decisión del operador, 29/oct/2026.** Reemplaza el diseño anterior que proponía que el conductor retuviera $32 y depositara $221 a Tala Eats. **Esto no es una autorización para activar cobros ni transferencias LIVE.**

## Política comercial: un estado de cuenta transparente

- El restaurante mantiene su caja de efectivo y es el deudor comercial de las comisiones y servicios de pedidos en efectivo que **realmente tiene bajo su custodia**.
- Cada semana se genera un estado de cuenta por comercio, por pedido, con conceptos de producto, descuento, tarifa de servicio, envío, propinas, comisión 15%, ganancia del restaurante, pago del conductor, ajustes y cobros físicos y digitales.
- Los cobros con Stripe originan obligaciones a favor del restaurante **solo cuando sus importes estén reconciliados y disponibles**, sujeto al esquema de liquidación legal y técnico aprobado.
- Las deudas comprobadas por efectivo recibido por el comercio se compensan contra el saldo de tarjeta a pagar al comercio, con autorización contractual explícita, sin doble cobro y sin convertir el efectivo en fondos Stripe.
- Si el neto es positivo, Tala Eats adeuda al comercio; si es negativo, el comercio debe pagar a Tala Eats por un canal bancario identificado (no una transferencia bancaria negativa). Un importe calculado no implica que la transferencia ya ocurrió.
- Tala Eats paga al conductor mediante circuito separado; **el conductor no conserva su remuneración en efectivo del cliente**.

## Advertencia esencial: entrega a domicilio en efectivo

Cuando un cliente paga al conductor en la puerta, **el conductor necesariamente toca el dinero, al menos durante unos minutos**. No puede afirmarse honestamente que no lo custodia. Para que el restaurante sea el responsable de su caja, tiene que existir:
- Repartidor **propio del restaurante**, que lleva el efectivo a su caja; o
- Handoff físico de **todo** el efectivo del conductor Tala Eats al restaurante con importe exacto, fecha/hora, confirmación autenticada de ambos, recibo único, alertas de faltantes, límites de exposición y conciliación de la caja.

**No** marcar ese efectivo como recibido por el restaurante por el mero PIN de entrega del pedido. Hasta probar el handoff anterior en las apps y backend, mantener OFF domicilio efectivo con conductor Tala Eats.

## Ejemplo por semana (cuatro pedidos, cada uno productos $200, sin propina)

| Modalidad | Cliente paga | Restaurante devenga | Driver devenga | Tala Eats bruto |
|---|---:|---:|---:|---:|
| Pickup efectivo | $214 | $170 | $0 | $44 |
| Domicilio efectivo, efectivo ya recibido por restaurante | $253 | $170 | $32 | $51 |
| Pickup Stripe | $214 | $170 | $0 | $44 |
| Domicilio Stripe | $253 | $170 | $32 | $51 |
| **Total** | **$934** | **$680** | **$64** | **$190** |

- Tarjeta elegible a pagar a restaurante: $170 + $170 = **$340**.
- Efectivo recibido en caja del restaurante: $214 + $253 = **$467**.
- Deuda comercial de ese efectivo: ($214 − $170) + ($253 − $170) = **$127**; incluye parte de delivery que Tala Eats necesita para pagar al conductor, sin duplicar el ingreso.
- **Transferencia neta al restaurante = $340 − $127 = $213** (solo al aprobar conciliación y compensación).
- El restaurante acaba con $467 físicos + $213 de liquidación = **$680** de ingreso económico por las cuatro ventas. La plataforma paga al conductor **$64** de manera independiente. Tala Eats termina con $190 brutos antes de tarifas Stripe, impuestos y gastos operativos. No reconocer $127 como una segunda venta.
- Si no hubiera cobros con tarjeta compensables: deuda del restaurante **$127**, no transferencia negativa.

## Requisitos de estado semanal

Encabezado: nombre comercial/titular, periodo semanal America/Mexico_City (lunes a domingo), fecha de corte, ID de estado, versión, MXN, estado PRELIMINAR / EN REVISIÓN / APROBADO / LIQUIDADO / CON AJUSTES.

Cada fila: pedido ID, fecha/hora, producto, descuentos, precio, forma de pago, comisión, servicio, envío, propina, conductor pagado por Tala Eats, ingreso comercio, ingreso bruto plataforma, custodia de efectivo y doble acuse, evidencia Stripe firmada, reembolsos/disputas y movimientos compensatorios, referencia contable, estado de conciliación. No mostrar datos sensibles del cliente ni PIN.

Totales: vendido bruto, ganancias comercio, cobro efectivo comercial confirmado, tarjeta elegible, fondos todavía retenidos, comisión y tarifas, deudas cash, ajustes, neto a pagar **o** a cobrar, referencias de pago y depósitos bancarios, saldo anterior y siguiente periodo. PDF de estado y CSV de detalle. **Estado de cuenta no es CFDI fiscal**; cumplimiento de facturación SAT requiere flujo y asesoría propios. No crear comprobantes fiscales ficticios.

## Código RC12.8: diferencia detectada

- `src/live/rc85-commercial-policy.ts` calcula las tarifas.
- `src/live/payee-allocation.ts` hoy asigna la custodia de cash delivery al **driver** y le permite retener su pago, con `duePlatformMinor=total-driverAmount`. **Contradice esta nueva política**. No activar domicilio efectivo bajo la nueva política sin cambiarlo y probar cadena de custodia.
- `src/live/payee-finance-router.ts` ya registra obligaciones y custodia (`tala_live_cash_custody`); permite `/finance/cash/:orderId/submit` y revisión ADMIN, pero **no tiene liquidación bancaria verificada de efectivo**, correctamente.
- `src/live/treasury-policy.ts` separa saldo Stripe Connect y obligación; no convierte efectivo en saldo retirable.

## Implementado en esta rama RC13.1

- `src/live/weekly-merchant-statement.ts`: cálculo puro y **read-only** de liquidación semanal en centavos; exige conservación de totales por pedido, controles de cobro cash realmente entregado a restaurante, Stripe firmado + fondos disponibles, HOLD para disputa o no entregado y rechazo de duplicados.
- `tests/rc131-weekly-merchant-settlement.test.mjs`: cuatro modalidades ($213), semana solo efectivo (saldo deudor $127), handoff faltante, Stripe pendiente de disponibilidad, disputas y errores.
- **NO** constituye endpoint, factura, depósito o transferencia; no altera LIVE.

## Implementación real aún necesaria

1. Contrato del servicio: compensación por deuda de efectivo, custodia, calendario, objeciones, reparto de riesgo, impuestos y tratamiento fiscal.
2. Modelo/migración aditiva de custodia temporal driver → recibo **de todo el efectivo** autenticado por restaurante, incidentes y referencias bancarias. No sobrescribir historial de RC8.5.
3. Endpoints autenticados de consulta semanal (comercio y ADMIN) y vista `Wallet > Facturación semanal`; exportar CSV/PDF sin crear CFDI ficticio.
4. Snapshot y cierre semanal idempotente con revisión independiente ADMIN, saldos y compensación contractualmente autorizada, registros de transferencias o cobros y conciliación real SPEI/Stripe antes de estado LIQUIDADO.
5. Probar 2+ semanas, múltiples comercios, devoluciones tras cierre, disputas, transferencias repetidas, conductor no entrega dinero, y red/gps inestables. Nunca exponer al conductor saldo retirable sin backend certificado.

**Piloto 8 nov:** priorizar claridad y corte auditable; si aún no se aprueba el proceso de handoff físico, NO abrir entrega en efectivo con repartidor Tala Eats. Los demás medios se habilitan por gates propios.

**Esta propuesta no toca PM2, PWA LIVE, Stripe, claves o DB LIVE.**
