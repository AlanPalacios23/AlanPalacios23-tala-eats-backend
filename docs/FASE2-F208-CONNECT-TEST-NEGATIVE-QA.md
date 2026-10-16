# F2.08 · Stripe Connect TEST — cobertura aislada adicional (NO LIVE)

Este cambio agrega regresiones contra el cliente **simulado** de Stripe Connect
en `test_connect_self_service_v164.py`, sin conexión Stripe, sin API key TEST/LIVE,
sin pagos y sin usar bancos reales. La matriz rechaza cuentas ajenas,
restaurantes no verificados, timeout del proveedor, schedules de payout
automático, paginación de bancos y múltiples destinos, país/divisa distinto,
estados de banco no válidos y números de cuenta que deben mantenerse privados.

Un banco que aparezca como `verified` en el mock **no libera ningún retiro**:
`can_withdraw=false` permanece independiente de KYC, fondos y bancos.
Tampoco equivale a una prueba auténtica de Stripe TEST.

**Bloqueo F2.08 principal:** sigue pendiente una cuenta TEST de restaurante
y una de repartidor con onboarding real, KYC de prueba, destino bancario
ficticio permitido por Stripe TEST, eventos Connect firmados,
transferencias/payouts TEST, conciliación por cuenta y captura de IDs
no secretos/redactados. Nunca habilitar fondos LIVE por estos checks.

Los resultados deberán enlazarse desde GitHub Actions al issue maestro #43
una vez que el SHA final esté validado.