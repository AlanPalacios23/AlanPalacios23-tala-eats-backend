# Tala Eats RC11.2–RC11.7 — entrega a Kali (operación LIVE, sin simulaciones)
Fecha: 28/oct/2026. Este procedimiento prepara **código auditable** y jamás aprueba por sí solo operaciones financieras.

## Release encadenado
- PR #170 → RC11.4, incluye requisitos técnicos de RC11.2/3; script PM2 exclusivo con rollback.
- PR #177 → RC11.5, lectura KYC y balance Connect (sin transferencias).
- PR #178 → RC11.6, auditoría de incidencias/reembolsos/disputas y recuperación (sin reembolsos nuevos).
- PR #179 → RC11.7, prueba HTTP del API/worker y las 3 PWAs (sin compra ni login).
- PWA checkout pendiente: https://github.com/AlanPalacios23/tala-eats-version-web/issues/12.
- Criterios comerciales finales siguen en issues #171–#176. **No están aprobados por el resultado de CI**.

## Preparación inmutable — servicio tala-node-stage, sin tocar producción
Ejecutar desde el servidor Kali con acceso del operador. El valor `SHA` debe ser el **HEAD de 40 caracteres confirmado contra el commit con CI verde**. Si alguien actualiza la rama, no instalar el nuevo HEAD sin repetir CI.

```bash
# Variables a definir tras corroborar GH Actions del commit:
SHA="REEMPLAZAR_CON_SHA_DE_40_HEX"
BRANCH="feat/rc117-live-three-pwa-launch-gates-20261028"
OLD="REEMPLAZAR_CON_SHA_PM2_ACTUAL_CONFIRMED"
test "${#SHA}" -eq 40 && test "${#OLD}" -eq 40 || exit 2

sudo -iu tala-node-stage bash -s -- "$SHA" "$BRANCH" <<'PREP'
set -Eeuo pipefail
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
SHA="$1"; BRANCH="$2"
ROOT="$HOME/tala-node-releases/$SHA"
if [ ! -d "$ROOT" ]; then
  git clone --depth 1 --branch "$BRANCH"     https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend.git "$ROOT"
fi
test "$(git -C "$ROOT" rev-parse HEAD)" = "$SHA"
test -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)"
cd "$ROOT/node-backend"
node --version
npm ci
npm run generate
npm run db:validate
npm run build
npm test
bash scripts/rc114-kali-live-code-cutover.sh --plan "$SHA"
PREP
```

**No ejecutar `npm run db:migrate:deploy` contra LIVE** en este paquete. Cualquier migración debe tener plan, backup y aprobación separados.

## Instalación de código (solo después de --plan PASS, CI PASS, baseline real y rollback disponible)
El instalador requiere identidad exacta de ambos PM2, flags financieros seguros, migración existente y /ready local y público; si cualquiera falla, se detiene.

```bash
sudo -iu tala-node-stage bash -s -- "$SHA" "$OLD" <<'APPLY'
set -Eeuo pipefail
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
cd "$HOME/tala-node-releases/$1/node-backend"
bash scripts/rc114-kali-live-code-cutover.sh --apply "$1" "$2" I_APPROVE_RC114_LIVE_TWO_PM2_CASH_DELIVERY_CODE_ONLY
bash scripts/rc114-kali-live-code-cutover.sh --verify "$1"
APPLY
```

El instalador usa el recibo `~/.config/rc114-cash-delivery-previous.json`; **nunca borrar ni sobrescribir** el recibo de RC11.3. Conservar backups. La protección de este paquete deja todos los flags de domicilio cash, domicilio card y retiros Connect OFF.

## Auditorías sin escrituras (posteriores a instalación; cada script devuelve HOLD hasta que exista evidencia)
```bash
sudo -iu tala-node-stage bash -s -- "$SHA" <<'CHECK'
set -Eeuo pipefail
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
cd "$HOME/tala-node-releases/$1/node-backend"
ENVFILE="$HOME/.config/talaeats-node-live.env"
node --env-file="$ENVFILE" scripts/rc114-kali-live-cash-readiness.mjs "$1"
node --env-file="$ENVFILE" scripts/rc117-kali-live-public-preflight.mjs "$1"
# Ejecutar después de contar con pedidos cash entregados:
# node --env-file="$ENVFILE" scripts/rc114-kali-live-cash-ledger-audit.mjs "$1"
# Stripe pickup: requiere haber cobrado un pedido legítimo:
# node --env-file="$ENVFILE" scripts/rc114-kali-live-stripe-pickup-audit.mjs "$1"
# Connect: requiere mapeos legítimos:
# node --env-file="$ENVFILE" scripts/rc115-kali-live-connect-readiness.mjs "$1"
# Recuperación: requiere evidencia externa de backups y alertas:
# node --env-file="$ENVFILE" scripts/rc116-kali-live-financial-recovery-audit.mjs "$1"
CHECK
```

Si existe un HOLD, no ocultarlo, no inventar fixtures y no habilitar dinero por cambiar env.

## Rollback de código (sin rebajar BD financiera)
```bash
sudo -iu tala-node-stage bash -s -- "$SHA" <<'ROLLBACK'
set -Eeuo pipefail
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
cd "$HOME/tala-node-releases/$1/node-backend"
bash scripts/rc114-kali-live-code-cutover.sh --rollback "$1" I_APPROVE_RC114_ROLLBACK_PREVIOUS_TWO_PM2
ROLLBACK
```

**No restaurar un respaldo sobre PostgreSQL LIVE después de que exista movimiento de dinero**: una reversión del código no revierte operaciones en Stripe ni elimina asientos nuevos.

## Puesta en marcha comercial (operación autenticada y autorizada)
1. Confirmar tienda verificada/aprobada, driver aprobado/libre con GPS fresco, usuario comprador real, y consentimiento para una orden controlada. Verificar tres PWAs con roles reales.
2. Primero efectivo domicilio: autorización específica de su release cash; crear exactamente un pedido real, revalidar descuento stock, tienda prepara/ready, driver recibe/recoge, PIN correcto, efectivo contabilizado; correr auditor posterior y conciliar responsabilidad de efectivo.
3. Tarjeta **pickup**: PaymentIntent LIVE existente, webhook firmado, ledger, estado de restaurante y auditor externo Stripe GET.
4. Tarjeta **domicilio** requiere desarrollo y pruebas adicionales: checkout delivery Stripe no se puede activar con el código actual. La PWA moderna bloquea tarjeta; no desactivar este bloqueo hasta tener PaymentIntent/compensaciones propios.
5. RC11.5 retiros: ninguna llamada a transfer/payout sin saldo confirmado Connect + ledger atribuible, idempotencia, autorización MFA, webhook firmado y estado bancario. La plataforma tiene capacidades Stripe, pero eso no implica que backend de Tala Eats esté listo.
6. RC11.6: probar incidentes con cargos y reembolsos reales consentidos, importes bajos, sin dobles asientos. Firma y registros antes de cerrar un caso; ninguna alerta sustituye la prueba.
7. RC11.7: restaurar backup en base **aislada**, probar alerta recibida, rollback API/worker, tres versiones PWA exactas, estados y finanzas; registrar GO/NO-GO y responsable.

**Estado al crear esta guía: código en GitHub, NO desplegado. Esta guía no concede autorización de mover dinero.**
