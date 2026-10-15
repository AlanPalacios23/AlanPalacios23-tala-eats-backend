# TALA EATS · Cobros en efectivo y liquidación real — diseño y gates

Estado: diseño de preproducción y **vista previa solamente**. **No lanzar a Kali, no cobrar por SPEI, no usar Stripe LIVE ni aprobar retiros con estos datos.** La política de recepción de efectivo es PROVISIONAL y requiere validación operativa y contractual.

## 1. Regla de negocio propuesta para piloto

- Entrega: repartidor cobra al cliente **todo el monto del pedido**, propina incluida; conserva únicamente el pago de reparto + su propina y remite el resto a TALA EATS. Tala Eats debe pagar al restaurante con dinero efectivamente recibido.
- Recoger: restaurante cobra al cliente; conserva la parte neta de sus productos y remite a TALA EATS la comisión y la tarifa de servicio.
- El ticket se calcula en backend, en MXN Decimal. No depender de precios/carrito/tarifas sugeridas por Flutter. El contrato vigente 1.6.2 para el piloto establece comisión restaurante 15%, servicio cliente 7% con tope $25, envío $35 hasta 2 km + $5 por km adicional, pago repartidor $32 hasta 2 km + $4 por km adicional, propina íntegra.
- Venta ilustrativa delivery: alimentos $200, servicio $14, envío $35, total $249. Beneficiarios: restaurante $170, repartidor $32, ingreso bruto Tala Eats $47. Repartidor **remite $217**, de los cuales $170 son fondos ajenos retenidos temporalmente.
- Pickup ilustrativo: alimentos $200, servicio $14, total $214. Restaurante conserva $170, **remite $44**.
- Pedidos con descuentos, cobros parciales, subsidios, reembolsos, reclamaciones, pedidos reasignados y entregas propias de restaurante requieren conciliación explícita, no estimaciones.

## 2. Qué implementa esta rama (sin movimientos)

Archivos:
- `backend/app/cash_preview.py`: función pura de proyección por pedido y suma **solo de la página**. Rechaza estados no entregados, efectivo no registrado, refund, colector desconocido, aritmética inconsistente o datos inválidos.
- `backend/app/routes/cash_preview.py`: exclusivamente **GET** con autenticación y ownership.
  - `GET /api/v1/cash-preview/admin?days=7&limit=100` — ADMIN, hasta 31 días / 200 registros por página, ventana UTC y señal has_more.
  - `GET /api/v1/cash-preview/driver/me?days=7&limit=100` — solo entregas del repartidor autenticado.
  - `GET /api/v1/cash-preview/restaurant/me?days=7&limit=100` — solo recogidas en el comercio propiedad del usuario.
- Se excluyen pedidos no entregados y medios de pago distintos de efectivo antes de consultar; el resto se somete a control de condiciones.
- Historial `CashSettlement` o `Payout` heredado del colector implica `historical_hold` y evita inferir dinero todavía adeudado: los períodos viejos pueden solaparse.
- Todas las respuestas dicen `preview_only=true`, `bank_verified=false`, `may_collect=false`, `actionable=false` por pedido. **No son cuentas por cobrar exigibles** ni prueba de caja/SPEI.
- No hay `POST/PATCH/DELETE`, webhook, tablas nuevas ni cambio sobre `/withdrawals`, orden o Stripe.
- `backend/tests/test_cash_preview_v1.py`: regresiones numéricas, propinas, hold histórico, vista parcial, autenticación y roles.

**Nota:** el backend actual establece `cash_collected = total` cuando marca una entrega pagada en efectivo, pero ese campo es un evento de software, **no una verificación de dinero físicamente recibido**. Por eso la vista se rotula siempre como no verificada.

## 3. De vista previa a liquidación real — fases pendientes

### Fase B · Identidad del dinero y origen de la cobranza
- Definir y aprobar por escrito quién tiene el efectivo y quién confirma el cobro, con diferencias entre domicilio, recogida, entrega propia y pedidos excepcionales.
- Registro único e idempotente por orden: colector (rol/id), importe final, método, instante UTC, GPS opcional no mostrado en finanzas, verificación de PIN/handover, prueba e identidad del actor.
- Captura de pago independiente del evento "entregado". Confirmación de cliente/repartidor o restaurante cuando la política la exija; estados `reported`, `disputed`, `validated`.
- Garantizar una sola aplicación monetaria por pedido y eventos compensatorios para cancelaciones o reembolsos posteriores.

### Fase C · Ledger de obligaciones y lotes idempotentes
- Migración Alembic incremental desde **head realmente desplegado** tras backup y revisión. Tablas de `cash_collection_events`, `cash_settlement_allocations`, `cash_remittances` y `cash_bank_reconciliation_events`, con índices únicos por `order_id`/revision, colector/periodo, idempotency_key y bank transaction ID.
- Ledger doble vía: `cash_in_collector_custody`, `due_from_collector`, `payable_to_merchant`, `payable_to_driver`, `earned_platform_revenue`, `settled_platform_bank`, `adjustments`, `disputes`. **No usar GMV/ingreso como saldo bancario.**
- Corte diario fijo en zona America/Mexico_City con UTC para almacenamiento; no volver a calcular períodos deslizantes `days=1` como si fueran lotes nuevos.
- El modelo previo de `/operations/admin/cash-settlements/run` **no es idempotente** frente a ventanas repetidas; bloquear su uso para dinero real hasta migración.
- El generador previo de `/operations/admin/payouts/run` mezcla pagos digitales y efectivo; **no ejecutar para cobrar o pagar** hasta corregir origin-of-funds.

### Fase D · Remesas y confirmación bancaria
- Cuenta bancaria empresarial controlada por TALA EATS; referencia SPEI única por colector/lote, concepto y vencimiento. No almacenar ni exponer claves de banca por app.
- App Repartidor y Restaurante muestran monto proyectado, monto **verificado/exigible** (solo cuando exista), referencia e historial; soporte a aclaraciones.
- Comprobante adjunto es `proof_submitted`, **nunca “pagado”**. Confirmación por API bancaria / extracto autenticado / doble revisión ADMIN con comprobación de importe, CLABE destino, fecha y referencia; idempotencia por operación bancaria.
- Transferencia parcial y sobrepago se anotan de forma separada; cualquier discrepancia queda en revisión, no se compensa silenciosamente.
- Desembolso al restaurante de efectivo recolectado por driver solo cuando se haya confirmado recepción y descontado ajustes autorizados. Mantener los payouts reales por Stripe Connect separados.

### Fase E · Seguridad, producto y lanzamiento
- Panel ADMIN: cuentas por cobrar/conciliar, vistas por colector, días de atraso, identificadores bancarios enmascarados, auditoría append-only, autorizaciones segregadas, ajuste compensatorio, alertas.
- Repartidor: límite de exposición **propuesto, no aprobado**, impedir nuevas ofertas en efectivo cuando exceda; nunca bloquear entregas en curso y nunca penalizar otras formas de pago.
- Reminders push/SMS solo sin filtrar información sensible a la pantalla bloqueada.
- Contratos operativos con comerciantes/repartidores; revisión de facturación, impuestos y tratamiento de fondos de terceros en México. La retención temporal de dinero de terceros puede imponer requisitos financieros/regulatorios: validar con asesor legal y contable antes de usarla.
- Políticas de disputas y robos, cash-in-transit y ajustes. Seguridad de transportadores de dinero y límites de responsabilidad.
- Tests offline SQLite, integración PostgreSQL/Redis, concurrencia, migraciones, roles 401/403, cálculos monetarios, conciliación bancaria duplicada y rollback. **Correr runners en un único lote solo al concluir cambios**, como solicitó el fundador.
- Deployment a staging primero. Nada de main, Kali ni Stripe LIVE sin revisión y aprobación explícita.

## 4. Decisiones por ratificar
1. ¿Delivery cobra el repartidor y pickup cobra el restaurante? Se usa como hipótesis para el prototipo de solo lectura.
2. Frecuencia de corte (propuesta diaria) y fecha de remisión.
3. Mecanismo bancario confiable (SPEI con API/extracto conciliado); banco / costos.
4. Límite de efectivo por colector, mora, suspensiones y excepciones.
5. Quién absorbe faltantes, robos, devoluciones y ajustes; acuerdos escritos.
6. Habilitar/deshabilitar cash por zona/negocio antes del piloto.

## 5. Política de GitHub
Se trabaja únicamente en `feature/cash-settlement-v1-preview` y **NO se abre PR aún** porque los flujos `backend-ci` y `backend-finance-ci` se activan automáticamente al abrir PR hacia `main`. Ejecutar CI/PR únicamente cuando el lote esté completo y sea solicitado.
