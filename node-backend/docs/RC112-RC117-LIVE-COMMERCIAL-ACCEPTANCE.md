# Tala Eats — Cierre comercial RC11.2–RC11.7 (LIVE real)
Fecha: 2026-10-28. Fuente de verdad: seis issues de aceptación (#171 a #176).
No marcar una versión como COMPLETE por tener rutas HTTP, build verde o /ready=true.

| Versión | Issue | Gate comercial | Estado |
|---|---|---|---|
| RC11.2 checkout domicilio | #171 | Catálogo/stock y pedido real idempotente; tarjeta solo con captura firmada y ledger; efectivo = cuenta por cobrar hasta PIN | Código cash LIVE desplegado, **NO-GO comercial** |
| RC11.3 despacho y PIN | #172 | Driver aprobado, asignación exclusiva, seguimiento, recogida, PIN y reintentos sin acción ADMIN | Código desplegado, **NO-GO E2E** |
| RC11.4 contabilidad cash y Stripe | #173 | Cada pedido concilia total, comisiones, shipping, propina, receivables, cobro y firmas Stripe | Auditor efectivo y contrato PWA en PR #170, **NO-GO contable completo** |
| RC11.5 retiros | #174 | Balance Connect disponible, solicitud MFA, transferencia/payout externo idempotente y conciliado | **NO-GO**, transfers bloqueados |
| RC11.6 incidencias | #175 | Reembolso/disputa/cancelación/recuperación con ledger compensatorio e inventario estable | **NO-GO** |
| RC11.7 lanzamiento | #176 | E2E las 3 PWA, alarmas probadas, backup/restauración/rollback, aprobación responsable | **NO-GO** |

## Corrección de versión RC11.4
El PR #170 llamado "RC11.4 LIVE — capacidades PWA" resuelve solo un prerrequisito. La aceptación RC11.4 definida por el proyecto abarca **contabilidad de efectivo Y Stripe por pedido**. El PR no cierra el issue #173 por sí solo. No es válido decir que tarjeta domicilio LIVE funciona: `config.ts` bloquea `LIVE_DELIVERY_CARD_CHECKOUT_ENABLED` hasta implementar la integración de PaymentIntent, webhook firmado y ledger propios para entrega.

## Pruebas repetibles para RC11.4
- `npm run verify` y workflows CI del commit final, incluidos PostgreSQL/Redis.
- `node --test tests/rc114-cash-order-ledger-audit.test.mjs tests/rc114-kali-code-cutover.test.mjs` desde `node-backend`.
- Auditor de disponibilidad `scripts/rc114-kali-live-cash-readiness.mjs`: detecta al menos una pareja comercio verificado/abierto y driver aprobado/disponible con GPS vigente, y comprueba banderas financieras.
- Auditor de ledger `scripts/rc114-kali-live-cash-ledger-audit.mjs`: **solo** tras existir pedidos reales cash **completados**, comprueba PIN, cobro y conservación del split. No autoriza retiros y devuelve HOLD con cero pedidos. No exponer PII en logs.
- Para tarjeta Stripe LIVE, auditor propio contra confirmación firmada e información verificada del proveedor; cash audit no aplica a la tarjeta.

## Operación de RC11.4 en Kali — solo código, no liberar pagos
1. Registrar SHA final de rama y aprobar sus CI. Verificar personalmente el SHA actual de API y worker PM2 y cotejar contra baseline conocido `c8eb3f656e83f88f2bcbd56846405068b0f407d8`.
2. Crear release inmutable en `/home/tala-node-stage/tala-node-releases/<SHA>`, compilar Node 24, y mantener permisos `0600` del env LIVE bajo `tala-node-stage`. Nunca reutilizar DB staging ni alterar entornos financieros.
3. Usar **exclusivamente** `scripts/rc114-kali-live-code-cutover.sh` con `--plan <SHA>`, después `--apply <SHA> <BASELINE_SHA> I_APPROVE_RC114_LIVE_TWO_PM2_CASH_DELIVERY_CODE_ONLY`, y finalmente `--verify <SHA>`. No ejecutar `--apply` si el plan, CI o baseline fallan; conservar todos los receipts anteriores.
4. Verificar GET /api/v1/ready local y público; dos PM2 online; worker heartbeat; auth y contrato del checkout. Los tres flags cash, los tres flags tarjeta domicilio y Connect transfers permanecen OFF tras este cutover.
5. La liberación **comercial** requiere procedimiento aparte y validación de un primer pedido auténtico y consentido, con comprador, restaurante y driver reales, manual settlement cash controlada y supervisión. Evitar la paradoja de exigir evidencia de entrega real antes de permitir un primer pedido: diferenciar un piloto de producción controlado y la apertura pública. El auditor de ledger debe ejecutarse después del primer pedido y antes de declarar RC11.4 aprobado.
6. Posteriormente ejecutar RC11.5, RC11.6 y RC11.7 según sus issues. Stripe Connect **transfer** y **payout bancario** son operaciones distintas; ambas requieren conciliación externa. Ningún control de disponibilidad interna prueba llegada al banco.

## Criterio de GO/NO-GO
- **NO-GO** si no existe comercio real registrado/aprobado, driver disponible, primera compra/entrega/contabilidad coherente, CI completa, alarma o rollback.
- **NO-GO** si cualquier pago con tarjeta se muestra como pagado sin recibo Stripe firmado persistido.
- **NO-GO** si wallet muestra cash recaudado por el driver o ventas brutas como dinero bancario retirable.
- **NO-GO** para lanzamientos con retiros mientras `STRIPE_CONNECT_TRANSFERS_ENABLED=false` o no exista adaptador probado de balance disponible, ejecución y reconciliación.
- **GO** solo con acta de aprobación fechada, SHA de todos los componentes PWA/backend, evidencias contables y encargado de operación de incidentes.
