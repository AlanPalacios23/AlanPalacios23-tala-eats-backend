# RC12.9 — Piloto LIVE limitado: domicilio efectivo antes de tarjeta
Fecha: 29-oct-2026. Baseline RC12.8 desplegado en Kali: `1562827129b90094bce90cca3647c57d94e33fcc`.

## Objetivo, sin confundir GO técnico con GO financiero
El operador quiere **Cliente → Restaurante → Repartidor → PIN → Wallet**, primero con una sola terna autorizada. Este cambio agrega un **allowlist del primer piloto** al backend productivo, sin activar por sí mismo checkout, despacho, Stripe, Connect ni retiros.

Se crea un único piloto de **un comprador customer, un comercio verificado/abierto y un repartidor aprobado con GPS fresco**. La asignación no podrá salir de esa terna aunque alguien habilite las banderas de delivery por error. Este mecanismo no es un límite de importe ni una certificación contable; requiere supervisión.

## Controles nuevos (solo env LIVE privado)
- `LIVE_DELIVERY_PILOT_CUSTOMER_ID`: ID numérico del cliente comprador de prueba real.
- `LIVE_DELIVERY_PILOT_RESTAURANT_ID`: ID del comercio **aprobado por ADMIN**, con titular/Connect propio.
- `LIVE_DELIVERY_PILOT_DRIVER_ID`: ID del usuario **driver**, aprobado, disponible y con GPS válido.

Los IDs deben ser números enteros positivos, no identidades ficticias ni credenciales. **No** agregar estos valores al repositorio ni copiarlos de staging. Si se activan banderas de entrega LIVE (efectivo o tarjeta) sin la terna completa, `config.ts` rechaza el arranque con `RC129_LIVE_DELIVERY_PILOT_SCOPE_REQUIRED`.

El piloto obliga a que:
1. `/restaurants/:id/delivery-readiness` devuelva `ready=false` al comprador que no pertenezca a la terna.
2. El checkout de `delivery` exija comprador y restaurante exactos **antes de reservar stock o crear pedido**; los métodos `pickup` no cambian.
3. El intento de pago de un pedido **delivery** pendiente vuelva a verificar comprador + restaurante, de forma que un pedido anterior no esquive el piloto.
4. `hasReachableLiveDriver`, `driverAccept`/asignación, ofertas del driver y el barrido de worker filtren al conductor y a los pedidos exactos.
5. El operador conserva las comprobaciones existentes de Connect, GPS TTL, idempotencia, PIN, ledger, outbox y cargos firmados.

Este cambio **no crea cuentas**, no aprueba automáticamente al comercio ni convierte efectivo físico en saldo Stripe disponible.

## Secuencia controlada y condiciones (NO ejecutar a ciegas)

### Fase A — despliegue de CÓDIGO SOLO, todas las banderas de domicilio OFF
1. Revisar PR, GitHub Actions, pruebas `npm run verify`, tests RC12.3 y RC12.9, TS build y gates de migraciones; compilar en release inmutable. **No** sustituir SHA actual sin un plan formal de rollback y backup verificado.
2. Consultar *en LIVE* (sin imprimir nombres, email, claves, GPS o datos bancarios) que exista una terna real y que cada rol pertenezca a su dueño. El único driver LIVE conocido al 29-oct ya estaba verificado, online y con GPS fresco, pero eso puede caducar; medirlo de nuevo.
3. Dejar todas las banderas de despacho y tarjeta de domicilio, y transferencias Connect en `false`. Mantener los flujos de pickup que ya estén aprobados sin alterarlos. Los IDs piloto pueden configurarse con domicilio OFF; hacerlo por procedimiento privado con backup/rollback, **no** en un chat.
4. Verificar PM2 API/worker con mismo SHA, `/ready` local y público, 3 PWA LIVE, webhook Stripe original y configuración financiera. **No** arrancar un instalador antiguo RC9.5 ni mezclar el PM2 paralelo de STAGING.

### Fase B — efectivo en puerta, piloto restringido, previa aprobación
No habilitar todavía si:
- El comercio no está formalmente aprobado, mapeado a su **propio** Stripe Connect y validado por lectura remota, aunque el pago sea efectivo.
- No hay driver elegible con GPS fresco, capacidad, radio de recogida y distancia/stock/precios server-side reales.
- La suite E2E de efectivo sobre ambiente desechable, monitoreo de worker/outbox, reversión/backup e incidente no están comprobados.
- No está designado un operador que observe la primera compra con consentimiento del comprador/negocio/repartidor, y que pueda detener nuevos pedidos inmediatamente.

Una vez aprobada por separado la fase B, el servidor acepta las **tres** banderas de efectivo juntas:
`LIVE_DELIVERY_CASH_CHECKOUT_ENABLED`, `LIVE_DELIVERY_CASH_DISPATCH_ENABLED`, `LIVE_DELIVERY_CASH_RELEASE_APPROVED`.
Nunca cambiarlas individualmente (el backend hace fail-closed).

**Prueba única:** cotización server-side → confirmar pedido de efectivo **sin llamar Stripe** → restaurante confirma/prepara/READY → worker asigna al driver autorizado → recoge → en camino → entrega PIN → prueba del efectivo cobrado y ledger idempotente exacto, stock/outbox/notificaciones. Repetir lectura del mismo pedido/intent y verificar que no hay duplicados. Verificar que otro cliente y otro comercio NO pueden crear delivery piloto; otra cuenta driver no puede ver/aceptar la asignación.

### Fase C — tarjeta a domicilio, liberación separada
Permanecerá **OFF** mientras no exista un E2E real en **Stripe TEST** con webhook externo firmado, PaymentIntent, ledger, restaurante, asignación, PIN, reembolsos/disputas y restauración. No confundir HMAC local ni CI mock con recibo externo del proveedor. Tras aprobación financiera independiente, `LIVE_DELIVERY_DISPATCH_ENABLED`, `LIVE_DELIVERY_CARD_CHECKOUT_ENABLED`, `LIVE_DELIVERY_RELEASE_APPROVED` y `LIVE_DELIVERY_CARD_E2E_APPROVED` deben activarse como conjunto, y el mismo allowlist continúa protegiendo el primer canary. Verificar monto máximo, reintentos e idempotencia.

### Fase D — Wallet/retiros
`STRIPE_CONNECT_TRANSFERS_ENABLED=false` se mantiene; el código RC12.8 bloquea transferencias/payouts LIVE con independencia de las banderas delivery. Retirar ganancias exige saldos liquidados realmente disponibles por beneficiario, MFA, doble aprobación, idempotencia, verificación bancaria y conciliación Stripe Connect (transfer y payout son etapas distintas). **No** habilitar el botón de retiro ni anunciar dinero disponible por un pedido cobrado en efectivo.

## Auditoría inmediata disponible antes del nuevo despliegue
Con el release RC12.8 **actual** en Kali se puede ejecutar la suite existente de solo lectura (sin inventar otros scripts):

```bash
sudo -iu tala-node-stage bash <<'AUDIT'
set -Eeuo pipefail
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
SHA=1562827129b90094bce90cca3647c57d94e33fcc
cd "$HOME/tala-node-releases/$SHA/node-backend"
test "$(git -C .. rev-parse HEAD)" = "$SHA"
test -f "$HOME/.config/talaeats-node-live.env"
node --env-file="$HOME/.config/talaeats-node-live.env" scripts/rc119-kali-live-blockers-diagnostic.mjs "$SHA"
AUDIT
```

Este auditor RC119 solo lee conteos: tiendas, mapping/approval, driver elegible y eventos outbox. Para auditoría ampliada de capacidad, Connect, recuperación y 3 PWA también existe `scripts/rc118-kali-live-business-readiness.sh "$SHA"` (puede marcar HOLD si no existe comercio apto). **El resultado no enciende funciones ni demuestra un E2E**.

## Rollback y evidencia
- Si el piloto fallara, **primero cerrar la admisión de NUEVOS pedidos** con el procedimiento de cambio de env controlado (valores de grupo todos en `false`), sin perder órdenes existentes. No desactivar la máquina de estados de pedidos activos sin una estrategia de atención/manual porque se bloquearía su entrega.
- Los tres IDs no deben reemplazarse con pedidos activos; cualquier modificación de terna durante una entrega debe quedar registrada y revisada.
- Conservar y reconciliar pedidos, cash ledger, outbox y pruebas PIN; no “revertir” dinero con un `git reset` ni restaurar un dump sobre órdenes reales.
- Guardar SHA backend/PWA, resultado CI, operador, ventana, recibos Stripe TEST/firmas, estados del primer pedido y evidencia de alertas/recuperación sin datos privados. No declarar **GO** por HTTP 200.

**Estado de este PR: código preparado para revisión, NO desplegado en Kali, NO ha cambiado banderas ni efectuado cobros.**
