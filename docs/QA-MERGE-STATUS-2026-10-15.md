# TALA EATS Backend — estado real de merges QA al 15/oct/2026

Este registro distingue **pruebas de código** de **integración en rama**, **main** y **despliegue productivo**. Los commits de merge se hicieron con `[skip ci]` para evitar consumir minutos hospedados; esto NO constituye una validación nueva del commit combinado.

## Fusionado

| PR | Destino exacto | Commit de merge | Evidencia anterior al merge | Restricciones |
|---|---|---|---|---|
| #40 Privacidad GPS + push obsoleto | **main** | `c254a76d7fd9d35325c94ea600e373269c7337b3` | [Windows QA 253 PASS](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38771425138); preflight, Alembic head PASS | Falta E2E Android GPS/FCM y PostgreSQL/Redis con este cambio antes de **desplegar** |
| #41 Monitor manual /ready | `release/p0-checklist-last-four` (rama de #20) | `71ab7a0c13865c093a483d55030caebd3769c955` | [Windows offline 4 PASS](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38772642704) | No se ha validado `/ready` desde red externa ni alertas |
| #42 Pagos GO/NO-GO seguros | `release/payments-go-live-gate-2026-10` (rama de #29) | `7f001c46ed75ffece680e2a49566a7f4dfecb6bb` | [Windows QA 294 PASS/17 Linux SKIP](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38773548357) y [25 financieros PASS, workflow SUCCESS](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38774292373) | No autoriza pagos, transferencias ni retiros LIVE |
| #20 Laboratorio P0 5–8 + monitor #41 | `release/p0-checklist-first-four` (rama de #19) | `56a60128d77badc1a9d5257b33a37900495770b6` | [Backup/E2E 4 roles/alertas en laboratorio](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38510250338); [carga/Redis/rollback laboratorio](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38510251905); #41 offline PASS | No es release para producción; #19 sigue DRAFT |

## Abiertas / todavía NO aptas para merge directo a main

- **#19** checklist P0: ahora integra #20/#41 en su rama. Falta verificar conjunto exacto tras merge, Kali vs GitHub, Stripe TEST E2E externo, Android y monitoreo de guardia.
- **#29** candidato financiero: ahora integra #42 en su rama. Antes de `main`, requieren aprobación independiente para cambios legacy y conciliación, pruebas externas Stripe/MP/Connect, PostgreSQL/Redis sobre nuevo head, Android y rollback.
- **#25, #27, #28** Finance V2/hardening: QA aislado en etapas, dependencias y cambios financieros acumulados; #25 tuvo **security audit FAILURE**; ningún PASS aislado autoriza producción ni elimina la revisión de integración.
- **#14** `client_reference`: evita colisiones, pero faltan verificación de payload normalizado, móviles reales y staging con pérdidas de Redis; #19 incluye parte de estos cambios.
- **#7 Stripe 16**, **#10 SQLAlchemy 2.1**, **#12 Uvicorn 0.54**, **#13 MercadoPago 3.6**: checks de CI verdes en su SHA, pero son cambios de SDK/runtime que necesitan revisión de compatibilidad y, para proveedores de dinero, E2E en TEST. No se fusionan automáticamente solo por checks verdes.
- **#11 Python 3.14**: pytest **FAIL**, queda bloqueada.

## Límites preservados

- Repositorios privados; runner propio Windows `tala-eats-backend`, workflow manual.
- Sin despliegue a Kali; sin modificación de `.env.production`, secretos, infraestructura, bancos ni PSP.
- `automatic_real_money_activation_authorized=false` y sin habilitar cobros/transferencias/retiros LIVE nuevos.
- El siguiente paso es ejecutar gates faltantes, y repetir validación para los SHA **combinados** de #19 y #29; luego decidir si se fusionan a main. Los QA de Windows no sustituyen pruebas de Linux/PostgreSQL ni dispositivos Android.
