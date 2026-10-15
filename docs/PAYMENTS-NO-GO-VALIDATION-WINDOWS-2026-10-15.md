# Auditoría QA adicional sobre PR #29 — no activa dinero

Esta PR apilada mejora **únicamente** el comando read-only `app.payment_go_live_gate` y sus pruebas.
No accede a Stripe, Mercado Pago, banca, servidor Kali ni muta variables.

## Errores que evita

1. El diagnóstico no puede señalar configuración de retiros completa si `withdrawals_approved_accounts` y `withdrawals_approved_bank_destinations` contienen cuentas distintas, pares repetidos, bancos sintácticamente inválidos o cuentas sin banco asociado. Verifica el formato `acct_...:ba_...` según el contrato backend actual.
2. El diagnóstico no acepta `foo`, un placeholder o tokens TEST como Mercado Pago LIVE configurado. El patrón `APP_USR-...` es **solo una heurística de prefijo**; no garantiza capacidad de cobro, autenticidad ni cuenta habilitada.
3. Todos los resultados conservan `independent_provider_and_bank_verification=false` y `automatic_real_money_activation_authorized=false` sin excepciones.

## Mañana en Windows (aislado)

```powershell
cd backend
python -m pytest -q tests/test_payment_go_live_gate.py
python -m app.payment_go_live_gate
```

El último comando **debe finalizar en código 2** aun con variables aparentemente completas: es una compuerta NO-GO manual.
Ejecutar el resto de QA en PostgreSQL/Redis efímeros según PR #29 antes de considerar merge.
No establecer `STRIPE_ENABLED` ni `WITHDRAWALS_LIVE_ENABLED` con valores reales para una prueba.

## Dependencias

PR base: #29 (release candidate Finance V2). Esta rama no se debe fusionar directamente a `main` hasta revisar el contrato financiero, backup/rollback y autorizaciones. La PR #29 sigue DRAFT.
