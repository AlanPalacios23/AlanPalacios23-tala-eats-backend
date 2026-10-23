# Tala Eats — RC8 POSTDEPLOY 2026-10-23.1

**Estado de este artefacto: release candidate de auditoría postdespliegue, NO deploy LIVE.** Mantiene la restricción del usuario: integrar primero código y pruebas en GitHub; desplegar una sola versión sobre la API Node.js existente de Kali con PM2 y Cloudflare únicamente cuando se autorice. Ningún archivo aquí reinicia PM2, realiza migraciones, crea pagos, edita Stripe o mueve fondos.

## Identidad

- Proyecto: `AlanPalacios23/AlanPalacios23-tala-eats-backend`, PR [#139](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/pull/139) (derivado de RC8 #135)
- Versión del paquete de verificación: **RC8-POSTDEPLOY-20261023.1**
- Script: `node-backend/scripts/rc8-postdeploy-audit.mjs`
- Tests: `node-backend/tests/rc8-postdeploy-audit.test.mjs`
- SHA: pasar el SHA **completo y exacto** de la release aprobada; no reutilizar un SHA anterior al siguiente commit ni tomar HEAD de una rama móvil
- Cuenta de Linux: `tala-node-stage` (sin root)
- Procesos existentes: `tala-node-stage-api` y `tala-node-stage-worker`
- Origen local: `127.0.0.1:18190`, dominio existente: `https://talaeats.alan-palacios-dev.com/api/v1`

## Validaciones automatizadas posteriores al despliegue

1. El operador es `tala-node-stage`; no ejecuta como root.
2. Archivo de variables de entorno adecuado al modo, propietario correcto, modo `0600` y no symlink; jamás imprime claves.
3. El SHA coincide con el commit Git ejecutado; directorio de release no es enlace simbólico y archivos versionados están limpios.
4. Exactamente las dos aplicaciones PM2 actuales están online, bajo el mismo directorio de release y con `NODE_ENV` esperado.
5. Endpoints local y HTTPS público responden JSON de salud/readiness, base de datos y Redis operativos, heartbeat de worker y proveedor Stripe.
6. Los estados financieros del contrato son inequívocos: staging **sin** cobros, LIVE **con** cobros solo cuando exista runtime de producción aprobado.
7. Ambos orígenes anuncian la misma versión, entorno y banderas financieras. Esto es consistencia observable, **no prueba criptográfica** de que el tráfico pasó por el mismo proceso.
8. No se invocan cambios de Cloudflare, PM2, SQL, Stripe, Docker ni hooks de transferencia.

### Comando futuro — verificar RC8 staging promovido

Solo después de promover un SHA revisado a la **API PM2 existente**, ejecutar como usuario `tala-node-stage`:

```bash
SHA=<COMMIT_COMPLETO_APROBADO_DE_40_CARACTERES>
sudo -u tala-node-stage -H bash -c '
  export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
  SHA="$1"
  node "$HOME/tala-node-releases/$SHA/node-backend/scripts/rc8-postdeploy-audit.mjs" --mode stage "$SHA"
' _ "$SHA"
```

**Resultado esperado en staging:** `POSTDEPLOY_STAGE_CONTRACT=PASS` y `STRIPE_LIVE_CHARGES=OFF`. Si falla, parar promoción y revisar backups, PM2 y reverse proxy sin reinicios automáticos.

### Comando futuro — verificar contrato LIVE (NO ejecutar todavía)

Únicamente cuando el checkout, conciliación/compensación y producción estén totalmente implementados y revisados, la base de datos y Redis tengan separación y restauración probadas, los webhooks funcionen y el operador apruebe la activación, verificar el runtime actualizado:

```bash
SHA=<COMMIT_COMPLETO_APROBADO_DE_40_CARACTERES>
sudo -u tala-node-stage -H bash -c '
  export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
  SHA="$1"
  node --env-file="$HOME/.config/talaeats-node-live.env"     "$HOME/tala-node-releases/$SHA/node-backend/scripts/rc8-postdeploy-audit.mjs" --mode live "$SHA"
' _ "$SHA"
```

**Este comando no habilita LIVE:** comprueba la API y fallará actualmente porque la API PM2 de RC8 informa `productionReady=false`, `financialWrites=false` y los módulos de refund/chargeback y producción no han completado todos los requisitos. La opción `--mode live` no es un interruptor para cobrar.

## Obligatorio fuera de la auditoría automática

- Congelar SHA exacto, revisión de diff, firma y resultados de CI; backup verificado y restauración de datos.
- Confirmar compatibilidad de las apps Flutter de cliente, comercio y repartidor, flujo de pedido y precios reales; preservar comisiones acordadas.
- Endpoint LIVE firmado en Stripe hoy: `/api/v1/payments/stripe/webhook`; configurar eventos `payment_intent.succeeded`, fallas/cancelaciones, refund.created/updated/failed, charge.dispute.created/closed.
- Probar recepción firmada y persistencia, reintento por timeout, duplicado y reordenado; reembolso parcial/completo, liberación segura de inventario, movimiento del ledger, cancelación, disputa, compensación al comercio y reconciliación contra saldo Stripe.
- Verificar alertas, cola, payouts retenidos y cuentas Connect habilitadas.
- Ejecución de cargo/reembolso LIVE mínimo **solo con autorización explícita adicional del operador**, sin automatizar cargos de prueba.
- Una vez aprobado el circuito completo, determinar GO/NO-GO. **Nunca interpretar un PASS de este script como autorización comercial autónoma.**

## Retroceso

- Guardar release anterior, backups y SHA anterior verificados **antes** de promover.
- Si el script falla, no hacer rollback ciego de cobros ya capturados: auditar PaymentIntents y webhooks pendientes, preservar ledger, outbox e idempotencia.
- Para staging se puede revisar el procedimiento PM2 con backups y rollback ya incorporado en `scripts/rc8-kali-public-pm2-upgrade.sh` y `scripts/kali-stage-first-pm2-promote.sh`, únicamente siguiendo sus aprobaciones explícitas.
- Para LIVE no usar el rollback staging como sustituto: falta desarrollar/ensayar procedimiento contable y de continuidad con tráfico de pago real.

**Nunca subir `.env`, secretos `sk_live_`/`rk_live_` o `whsec_`, datos bancarios ni credenciales de admin a GitHub o al chat.**
