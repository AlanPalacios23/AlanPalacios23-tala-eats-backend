# Tala Eats — RC8.5 Restaurant + Driver Payments

**Estado: ramas de desarrollo, no desplegado ni habilitado para dinero LIVE.** Backend PR #139; Flutter PR #62. No hay transferencias ni payouts ejecutados.

## Flujo del dinero
Un pedido tiene beneficiarios separados y estados contables independientes. Cada restaurante y repartidor debe disponer de su propia cuenta Stripe Connect verificada. La cuenta principal Tala Eats captura el cargo; una transferencia a Connect es distinta de un pago al banco del beneficiario.

**Ejemplo a domicilio (MXN):** productos 200, comisión restaurante 15% =30, tarifa cliente 7%=14, envío=39, repartidor base=32. Cliente paga 253; restaurante por cobrar 170; repartidor por cobrar 32; Tala Eats bruto antes de procesador, impuestos y costos =51. Cada propina íntegra aumenta solamente el saldo del beneficiario correspondiente, sin comisión.

## Custodia del efectivo
- Pickup: cliente paga directamente al restaurante. Restaurante conserva su parte y rinde a la plataforma comisiones y tarifa.
- Delivery plataforma: repartidor recibe total del cliente, conserva tarifa + propina y debe rendir el resto a Tala Eats. Tala Eats mantiene separado el pasivo al restaurante.
- Entrega propia: restaurante cobra y conserva productos netos + envío + propina, y rinde a plataforma los cargos debidos.
- Reportar efectivo, adjuntar evidencia y obtener revisión ADMIN no equivale a depósito bancario verificado. Por tanto NO se habilitó ruta de liquidación final sin integrar estados bancarios verificables.

## Backend integrado en RC8.5
- Migración PostgreSQL RC85: driver_accounts, payee_allocations, cash_custody. Claves únicas para evitar generar dos obligaciones por beneficiario y pedido; igualdad estricta entre efectivo total, retenido y adeudado.
- payee-allocation.ts: cifras en centavos, entrega probada, pedido cerrado, captura verificada para Stripe, cero incidencias de devolución o disputa.
- payee-finance-router.ts: alta Connect conductor verificado por ADMIN+MFA, confirmación del titular, enlace efímero Stripe, consulta de cuentas, ganancias y efectivo con sesión autenticada, creación idempotente de obligaciones retenidas y doble revisión para declaración de efectivo.
- transfer-planning.ts: propuesta read-only por destinatario con Stripe source_transaction, destino individual y clave de idempotencia, impide reembolsos y duplicaciones. Nunca llama a transfers.create.
- rc85-commercial-policy.ts: política 15/7%, base envío MXN39, conductor MXN32, 0% comisión de propinas.
- RC84 merchant-finance-router.ts: propietario restaurante consulta Connect desde Flutter y un beneficiario no puede usar la cuenta bancaria de otro.

## Flutter
- Restaurante > Finanzas: consulta pendientes, revisados no transferidos, efectivo por rendir, confirmación del titular y onboarding Stripe externo. Si API no responde se muestra indisponible, nunca cero inventado.
- Repartidor > Ganancias: consulta ingresos y efectivo por rendir, confirmación titular y onboarding Connect Stripe externo. URLs de Stripe se validan como HTTPS y hosts permitidos.
- Cambios móviles en PR draft #62; no compilaciones de release AAB ni publicación Play Store.

## Condiciones pendientes (NO-GO)
1. La entrega real con repartidor todavía está limitada en el runtime actual de Node al laboratorio y no se activa automáticamente por esta migración. Entrega propia debe tener modalidad operativa persistida para no liquidar al tercero incorrecto.
2. Stripe Connect requiere onboarding de cada beneficiario y verificación; faltan events webhook LIVE y validación con cargos/reembolsos auténticos autorizados.
3. Las transferencias Connect y los depósitos bancarios no están habilitados; se requiere reconciliación del cargo, del Stripe balance transaction y reversos cuando hay disputa.
4. Custodia física de efectivo todavía requiere ingreso bancario conciliado antes de marcarse pagada.
5. Falta aplicar/validar las migraciones, backup y restauración real en PostgreSQL productivo, QA de Flutter, revisión de compatibilidad de Play Store y promoción única a PM2 Kali.

**No transferir dinero, no desplegar ni habilitar cobros por el mero hecho de que los tests estén en PASS.**
