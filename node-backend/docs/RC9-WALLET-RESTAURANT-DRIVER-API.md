# RC9 — Contrato de Wallet para Flutter Restaurante y Repartidor
**Preproducción / 28-oct-2026. No expone retiros LIVE.**

Ambas apps consumen la **misma API Node**, con sesión del usuario autenticado, datos del beneficiario autorizado y `Cache-Control: private, no-store`. Jamás calcular saldo retirable desde pedidos, propinas u órdenes retenidas en el cliente.

## Lecturas permitidas (solo beneficiario)
- `GET /api/v1/withdrawals/restaurant/{restaurantId}/balance`
- `GET /api/v1/withdrawals/driver/{userId}/balance`
- `GET /api/v1/withdrawals/{restaurant|driver}/{id}/history`

Las lecturas contrastan el saldo de Stripe Connect, cuenta verificada, transferencias completadas, pagos bancarios previos y reservas; fallan de forma segura con `403` por identidad o `503` por conciliación.

Respuesta típica de saldo (ficticia):
```json
{
  "payee_kind": "restaurant",
  "payee_id": 42,
  "currency": "MXN",
  "unit": "centavos",
  "eligible_cents": "8500",
  "already_requested_cents": "0",
  "provider_available_cents": "8500",
  "withdrawable_cents": "8500",
  "withdrawable": "85.00",
  "bank": {"status": "verified"},
  "eligible": true,
  "blockers": [],
  "server_allows_requests": false,
  "payout_execution_enabled": false,
  "source": "verified_connect_transfers_only",
  "real_bank_payouts_created": false
}
```

**Regla crítica:** mientras `server_allows_requests !== true`, `payout_execution_enabled !== true`, `eligible !== true` o haya `blockers`, la app solo muestra Wallet en modo consulta y un CTA de retiro **deshabilitado e informativo**. No equiparar `withdrawable_cents` con autorización para retirar. El servidor continúa devolviendo `503 TREASURY_WITHDRAWALS_NOT_RELEASED` para POST mientras el kill-switch del código no se libere mediante una nueva release auditada.

## Solicitud de retiro — contrato preparado, NO activado
`POST /api/v1/withdrawals/{restaurant|driver}/{id}/request`

Cuando exista una liberación formal: requiere sesión verificada, TOTP del solicitante actualizado, UUID de solicitud **estable entre reintentos** y un importe entero en centavos (no dinero decimal y no número de cuenta bancaria proporcionado por la app). El backend comprueba todas las condiciones y devuelve **202 / reservado**, nunca «transferido» ni «pagado» por el simple POST. Los intentos de OTP están limitados a 5 cada 10 minutos, también entre distintos servidores. **No habilitar todavía esta acción en Flutter**.

```json
{
  "amount_cents": "5000",
  "request_key": "c51a51c8-18f7-40c2-99a4-a1f541a75f83",
  "totp": "123456"
}
```

Respuestas de referencia:
- `202`: `withdrawal_id`, `amount_cents`, `currency`, `state`, `created_at`, `new_reservation`, `bank_payout_created: false` y `requires_admin_dual_approval: true`.
- `403`: sesión/rol o MFA insuficiente.
- `409`: saldo/cuenta/OTP/idempotencia en estado HOLD; no reenviar creando otra clave.
- `503`: ejecución bloqueada por release o conciliación. **No significa que Stripe haya rechazado un cobro.**

Nunca mostrar OTP en registros, telemetría ni URL; no guardar PIN/OTP en el almacenamiento de Flutter. Los UUID de reintento pueden persistirse localmente solo hasta recibir un recibo de servidor inequívoco. Al perder conexión después de POST, consultar el historial **antes** de intentar una nueva operación.

## ADMIN: dos aprobaciones independientes, OTP nuevo por acción
- `POST /api/v1/admin/treasury/withdrawals/{withdrawalId}/review`
- `POST /api/v1/admin/treasury/withdrawals/{withdrawalId}/approve`
- `POST /api/v1/admin/treasury/transfers/{orderId}/{restaurant|driver}/{payeeId}/review`
- `POST /api/v1/admin/treasury/transfers/{orderId}/{restaurant|driver}/{payeeId}/approve`

```json
{"totp": "123456"}
```

Estas rutas requieren token ADMIN con MFA y un **segundo TOTP fresco por acción**, no reutilizable en ningún otro endpoint financiero (índice único admin/contador TOTP), con límite durable de intentos. La persona que solicita nunca puede aprobar su propio retiro, y el revisor y aprobador deben ser diferentes. Las rutas siguen apagadas y devuelven `503` mientras RC9 esté en NO-GO.

## Conciliación, estado desconocido y garantías
- `Transfer` (plataforma → Stripe Connect) no es `Payout` (Stripe Connect → banco).
- `reserved` no es enviado; `submitted` no es pagado; `unknown` **retiene fondos** y no se reintenta automáticamente.
- El worker optativo puede buscar un payout `unknown` en Stripe **solo en modo lectura**, corroborando cuenta, destino, importe, ID y beneficiario, sin repetir `payouts.create`.
- `paid` requiere webhook Connect con `Stripe-Signature` verificada y recuperación del objeto remoto de Stripe; el ledger `bank_payout_paid` tiene restricción de unicidad.
- Stripe LIVE, PostgreSQL LIVE, Kali, Cloudflare, PM2, tiendas y repartidores reales **no fueron modificados por este PR**.
- Falta la prueba con cuentas Stripe TEST Connect efectivas, los bancos mexicanos de prueba, verificación de reversos/disputas y aprobación específica del despliegue.

**PR de backend:** https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/pull/162
