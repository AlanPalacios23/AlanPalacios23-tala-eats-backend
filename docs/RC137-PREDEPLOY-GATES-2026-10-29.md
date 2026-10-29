# RC13.7 — evidencia y gate previo a despliegue (2026-10-29)

## Evidencia CI verificada
- GitHub Actions run 40944755001: SUCCESS, 3/3 jobs (cash GPS/PIN/hand-off, card synthetic KDS/GPS/PIN, signed webhook/PG15).
- GitHub Actions run 40944754988: SUCCESS, 2/2 jobs (500 órdenes sintéticas e inventario/cancelación/refund races, 400 journals/160 replays/20 conflicts).
- Estos son jobs agregados exitosos: **no sustituyen un pago real Stripe TEST** ni prueban que la infraestructura Kali LIVE está lista.
- La rama RC13.7 contiene pruebas con payloads Stripe TEST firmados localmente, readback de proveedor simulado y tests unitarios del conciliador LIVE. No se realizaron cargos reales ni retiros.

## Evidencia obligatoria adicional (bloquea GO)
1. **Pago real Stripe TEST**: ejecutar en staging aislado con credenciales `sk_test_` procedentes del secret manager (jamás versionadas), un comercio y repartidor de prueba; iniciar PaymentIntent TEST, confirmar mediante medio de prueba de Stripe; recuperar el PaymentIntent por API para acreditar `livemode=false`, moneda MXN, amount_received, metadata order_id/client_reference y estado `succeeded`. Evitar reenviar eventos sintéticos como prueba de cobro real.
2. **Webhook real desde Stripe TEST**: endpoint temporal HTTPS aislado, firma Stripe-Signature verificada contra el `whsec_` correspondiente, persistencia y deduplicación de `event.id`, 2xx ante reenvío. Correlacionar PaymentIntent con una sola orden, un solo pago y una sola actualización de libro mayor. Rechazar payload alterado y evento `livemode=true` en TEST.
3. **Delivery TEST**: cliente → orden pagada exactamente una vez → restaurante acepta/prepara/READY → driver verificado, GPS reciente y asignación única → recogida → entrega PIN. Comprobar roles, stock, eventos, firma y ausencia de doble cobro/asignación.
4. **Efectivo**: cliente compra cash delivery → driver registra cobro total → driver inicia handoff → restaurante confirma código e importe → una sola transición de custodia. La recepción física **no** es un depósito bancario ni un payout.
5. **Reembolsos reales TEST**: parcial y total contra pagos TEST elegibles, webhook/retrieve de Stripe `succeeded`; no modificar saldo antes de confirmación. Inyectar `pending`, `failed`, duplicados, importe excesivo y procesamiento fuera de orden. Registrar reverso compensatorio sin eliminar ledger; demostrar doble intento exactamente una vez.
6. **Conciliación**: para cada order_id comparar bruto del cliente, subtotal, tarifa servicio (7%), comisión comercio (15%), envío base configurado, pago repartidor configurado (referencia $32), propinas, fees proveedor, reembolsos y saldo retenido. Usar importes reales de la orden, no constantes cuando haya variaciones de tarifa; verificar conservación: entradas externas + cuentas por cobrar - salidas externas = cambio neto en cuentas y pasivos. Distinguir efectivo bajo custodia, Stripe pendiente, Stripe disponible, deuda de plataforma, comercio y repartidor. Mismatches > 0, retiros sin trazabilidad, ledger duplicado o saldo negativo no explicado => NO-GO.
7. **Kali**: comparar commit release y migraciones con PM2 API+worker, ejecutar backup/restauración probada, migraciones en staging, rollback de app, health/ready, conexión DB/Redis, webhooks activos, outbox/DLQ, configuración de los cuatro modos. No activar LIVE finance flags antes del piloto controlado y la conciliación.
8. **Permisos y controles**: CI no recibe `sk_live_` ni `whsec_` de producción. TEST solo con aprobación explícita y credenciales fuera del repositorio. No correr tests mutantes contra DB LIVE. Payouts/withdrawals/Connect LIVE OFF hasta gate independiente.

## Estado de entrega
- RC13.7: **CI simulada PASS**, revisión de despliegue **NO-GO** hasta evidencias 1–8.
- No se deben marcar las casillas anteriores como pruebas externas reales completadas por la sola existencia de mocks.
- Evidencias aceptables: URL del run, commit exacto, ID TEST no sensible, resultados por orden y diferencias de balance con cero desajustes (no incluir secretos, datos personales ni información bancaria).
