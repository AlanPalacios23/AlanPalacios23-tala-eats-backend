# F2.07 — Contrato de idempotencia por cuenta (GitHub, datos sintéticos)

La API crea un pedido único de cliente si recibe una `client_reference`
estable. En PostgreSQL `orders` incluye una restricción UNIQUE
`(user_id, client_reference)`, sin vencimiento mientras exista la fila.
El modelo acepta hasta **80 caracteres** (campo legacy opcional). El
servidor compara con HMAC la intención de compra almacenada en el evento
`received`; modificaciones de monto, carrito, dirección, pago, etc.
sobre la misma referencia reciben **HTTP 409**.

El middleware HTTP `Idempotency-Key` es una capa adicional,
no la fuente de veracidad. Su hash incluye identidad de sesión,
método, ruta y clave; reutilización con diferente cuerpo responde 409.
TTL de firma y caché Redis: **86,400 segundos (24 horas)**; lock Redis
de petición simultánea: **30 segundos**. Si Redis falla, POST /orders
conserva la garantía transaccional de PostgreSQL para la
`client_reference`. El vencimiento de caché Redis NO hace caducar
la restricción SQL del pedido original.

## Test en CI sin proveedores

`backend/tests/test_checkout_reference_integrity_phase1.py` añade
matriz de dos clientes reales *sintéticos* con el mismo texto de
`client_reference` y `Idempotency-Key`: deben producir dos pedidos
distintos y únicos por usuario; cada replay debe devolver solo el suyo,
la lista `/orders/mine` jamás debe mostrar el ajeno y el stock
solo puede bajar exactamente dos unidades. Otra prueba reutiliza
la referencia bajo un body modificado y exige 409 y un pedido único.

## Límites que permanecen abiertos

- Se debe verificar en el dispositivo la persistencia de la
  referencia tras cierre/reinicio, autenticación/restauración de sesión
  y lectura segura de pedidos.
- Pedidos legacy *sin* `client_reference` siguen siendo posibles:
  para una garantía universal se necesitará un contrato obligatorio
  validado y versionado para las **tres** aplicaciones.
- No se ha certificado Stripe TEST, Mercado Pago sandbox, dinero LIVE,
  ni el hash efectivo del binario desplegado en Kali.
- El test de aislamiento no autoriza cambios en producción ni
  movimientos de dinero.

Issue P0 #3 y #18; F2.07 principal permanece abierto.
