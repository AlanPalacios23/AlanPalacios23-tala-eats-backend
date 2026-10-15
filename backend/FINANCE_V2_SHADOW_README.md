# TALA EATS — FINANCE CORE V2 (NO PRODUCTIVO)

**Status:** Rama de desarrollo únicamente. `FINANCE_V2_SHADOW_ENABLED=false` por defecto. Nunca habilitar en Kali/Stripe LIVE sin auditoría, migración validada y autorización del propietario. El módulo es contabilidad **sombra**, NO un PSP ni servicio de retiro automático.

## Modelo económico respetado
Política productiva acordada: comisión restaurante 15% sobre alimentos netos, servicio cliente 7% con tope $25, envío $35 hasta 2 km + $5/km adicional, pago repartidor $32 hasta 2 km + $4/km adicional, propinas completas al repartidor en delivery y al restaurante en pickup. El motor usa exclusivamente **snapshots ya calculados por `monetization.calculate_order_economics`**: jamás cobra $40 de envío o $25 fijos porque estén en un ejemplo. No cambia reglas ni tasas por sí mismo.

La fórmula del prompt 'wallet driver -= subtotal+servicio+comisión' cuenta la comisión dos veces. Fórmula correcta si rider cobra cash: `repartidor_wallet_delta = driver_earning + tip - customer_total`. Para comida $200/servicio $14/envío $35/rider $32/comisión $30: cliente $249, merchant $170, rider $32, Tala Eats $47; rider wallet -$217 y banco Tala Eats $0 hasta recuperar los fondos.

## Datos implementados (migración f22j00000001)
- `finance_v2_journals` + `finance_v2_journal_lines` = diario balanceado por `order_id + delivered`, débito=crédito, con trigger PostgreSQL que impide UPDATE/DELETE.
- `finance_v2_wallets` = balance por beneficiario tipo + ID, entero de centavos firmado, receivables aún no financiados y exposición cash. **Saldo positivo NO habilita payout bancario**; `available_for_payout_cents` = 0, siempre, hasta implementar conciliación verificada.
- `finance_v2_wallet_movements` = historial irreversible de movimientos por pedido y beneficiario, sin duplicado.
- `finance_v2_cash_allocations` = responsable físico cash (repartidor para entrega; restaurante para pickup) y exposición; **status recorded no significa dinero bancario**.
- Se integra a `finalize_delivery` en la misma transacción únicamente cuando `FINANCE_V2_SHADOW_ENABLED=true`; si falla la contabilidad, revierte la transacción de entrega. Nunca toca SDK Stripe, retiros, wallet de fidelidad ni el pago físico.
- Nuevo router de **lectura** `/api/v1/finance-v2`: admin preview de asientos, consulta de wallet protegida por rol, preview corte semanal lunes-lunes en horario de Tala y consulta propia de wallet driver/restaurant. Todo responde 404 si el flag está OFF.
- Con flag ON se bloquean endpoints legacy peligrosos `POST /operations/admin/payouts/run`, `POST /operations/admin/payouts/{id}/mark-paid`, `POST /operations/admin/cash-settlements/run` y `PATCH /operations/admin/cash-settlements/{id}`; fuera del flag, su comportamiento anterior no cambia.
- Para flag ON únicamente: nuevas ofertas de repartidor en efectivo se filtran según máximo $500 MXN de exposición estimada **incluyendo nuevo pedido**, en los tres caminos: reclamación automática del driver, aceptación voluntaria y asignación del comercio; no impide órdenes digitales ni entregas ya en curso. Una versión posterior debe contemplar caja realmente conciliada y los límites parametrizables.

## Registros contables
**Efectivo:** débito receivable del colector del monto total; crédito payable merchant, crédito payable rider/propina, crédito ingresos Tala Eats; débito de pérdida operacional si la remuneración supera cobro. Separado del dinero real en banco.

**Digital:** débito receivable procesador y créditos a beneficiarios/revenue. Aunque el pago esté marcado `paid`, **no** se considera disponible: hay que validar saldo y transferencias Stripe/MP para liberar fondos. El módulo no ejecuta payouts, no hace transferencias a cuentas Connect, no genera impuestos reales y no usa fondos no verificados.

**Corte semanal:** `GET /api/v1/finance-v2/admin/weekly-cut/preview?week_start=YYYY-MM-DD` devuelve deltas por beneficiario, expresados en centavos, en zona `America/Mexico_City`. No hay job de pagos automáticos ni SPEI/OXXO manual.

## Lo que FALTA y constituye gate P0 antes de lanzarlo
1. Verificar head/migraciones en Kali, backups PostgreSQL/volúmenes y revisión de incompatibilidades de la rama con la release productiva. No ejecutar migración por este PR.
2. Cobro efectivo real y pruebas de custodia: hoy `finalize_delivery` marca `cash_collected=total` a partir de confirmar entrega, **sin verificación de billetes**, así que este registro es provisional y no autoriza desembolso.
3. **Conciliación triple** por pedido: PSP + banco + libro contable, con eventos firmados de pago/transferencia, idempotencia, retenciones, cash recovery y reversos por cancelación, contracargo o reembolso, sin doble ingreso.
4. Motor de compensación automática entre efectivo pendiente y **fondos digitales que legal y técnicamente estén bajo control de la plataforma antes de transferirse**. Los Stripe Connect transfers ya realizados no se pueden contabilizar como dinero pendiente de pagar para compensar. Verificar capacidades mexicanas del proveedor antes de domiciliar cargos a terceros.
5. Control efectivo comercial de faltante: saldo no verificado, límites por custodia, depósitos bancarios automatizados o servicio de recogida externo; una simple transferencia bancaria manual contradice la decisión del propietario. Sin medio real de recuperación, **no habilitar efectivo ilimitado**.
6. Cupones financiados por plataforma. La ruta legacy puede disminuir el payout al restaurante; por seguridad Finance V2 rechaza `promotion_subsidy>0` hasta implementar desglose explícito de financiación del descuento, con merchant payout preservado cuando el cupón lo paga Tala Eats.
7. Impuestos y retenciones: `indicative_vat_split` calcula **solo una referencia**. Si el IVA 16% está incluido en $44, el IVA aprox. es $6.07 (=44×16/116), no $7.04; una factura o retención definitiva depende del régimen, del precio con/sin IVA y asesoría fiscal SAT. No generar CFDI sin validación.
8. Compensaciones y reembolsos parciales con asientos reversibles de forma append-only; ante orden reembolsada, Finance V2 rechaza asiento por seguridad.
9. Backfill histórico y auditoría de los reportes legacy `financial_ledger_entries` / `Payout` / `CashSettlement` / `StripeTransfer`. No asumir que saldos del historial previo son disponibles.
10. Alertas y pruebas de carreras (PostgreSQL real, aislamiento SERIALIZABLE o bloqueos/advisory locks), replay, doble mensaje, doble webhook, falla parcial, conciliación de fin de semana, acumulados 1,000 pedidos y estrés.
11. QA tributario/legal México y contratos con comercios/repartidores que autoricen compensaciones futuras. El uso de una tarjeta tokenizada para cobrar saldos variables está supeditado a aprobación del PSP, no es una garantía ni una función habilitada de Stripe Connect en México.
12. AAB/APK UI: frontend de Usuarios/Restaurante/Repartidor/ADMIN no está conectado a estos endpoints; hasta completar la arquitectura evitar presentar `wallet.balance` como dinero retirables.

## QA aislado
`cd backend && python -m pytest -q tests/test_finance_core_v2_shadow.py`
Luego `python -m pytest -q` y `alembic heads`. Correr sobre SQLite descartable y después PostgreSQL efímero con migraciones para verificar trigger de inmutabilidad, concurrencia, rollback y permisos. No realizar transacciones Stripe LIVE.

## Estado de entrega
**Esta primera implementación constituye el núcleo contable y vistas sombra, no un sistema automático de cobro/payout productivo.** La siguiente fase implementa conciliación verificada, netting real y proveedor de fondos, con UI y aprobación explícita antes de cualquier movimiento de dinero.

## Nueva ronda — conciliación defensiva
- `GET /api/v1/finance-v2/admin/audit`: suma partida doble y reconciliación interna de proyecciones por cuenta; escaneo incompleto siempre devuelve `ok=false`. No es prueba de saldo bancario.
- `GET /api/v1/finance-v2/admin/netting/{owner_type}/{owner_id}/preview`: netting **hipotético**, nunca realiza débito ni crea abono; crédito sin verificar = 0 por defecto. El parámetro del operador NO cuenta como evidencia bancaria.
- `FINANCE_V2_CASH_LIMIT_ENABLED=false`: separar el control de nuevas ofertas cash del libro sombra; habilitar lectura no bloquea riders.
- Cuando Finance V2 sombra está ON, el retiro Stripe Connect queda retenido si hay efectivo no conciliado, incluso si existen otras ganancias digitales. Falta implementar compensación real, confirmación bancaria, conciliación PSP y reversos.
