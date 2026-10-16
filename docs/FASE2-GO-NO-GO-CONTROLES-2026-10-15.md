# TALA EATS — Fase 2: evidencia, conciliación y salida financiera controlada
**Fecha:** 15 octubre 2026 · **Estado:** NO-GO para activar o desplegar operaciones financieras LIVE.

El usuario decidió dejar F1.03 (proxy real Caddy/Cloudflare en Kali) en **standby hasta tener su laptop**. Este documento no cambia esa decisión: F1.03 y F2.02/F2.05 necesitan datos reales de Kali. La fase 2 puede continuar con GitHub Actions, servicios efímeros y mocks financieros seguros.

## F2.01 — Staging aislado
**Existe:** CI PG16+Redis8, Alembic HEAD, Python3.13 y simulación de pedidos, con credenciales sintéticas y sin claves reales.

**Falta para marcar [x]:** staging independiente persistente o efímero con evidencia de migración **desde el esquema realmente desplegado en Kali**, respaldo restaurado en copia desidentificada, API+worker y 3 apps apuntando al mismo entorno. Una base vacía migrada hasta HEAD no demuestra upgrade de datos históricos.

### Avance de laboratorio F2.03 — respaldo/restauración cifrados (sin Kali)

Se añadió el gate `qa.phase2_backup_restore_smoke`: después de crear un ledger de prueba
mediante F2.11, `pg_dump` crea un respaldo en formato PostgreSQL custom de la base
desechable; un archivo media contiene bytes 100% sintéticos. Ambos se cifran con
GPG AES256, se comprueban hashes SHA-256 de texto claro y cifrado, se eliminan
los archivos sin cifrar antes de comprobar el descifrado y se restaura PostgreSQL
en una **segunda base aleatoria** con nombre sujeto a guardas exactas. El ledger
se compara por cantidad y digest SHA-256, y el archivo multimedia por nombre
seguro y contenido íntegro. Además, se comprueba que hashes alterados se
rechacen y que nunca se acepte un nombre arbitrario de base de datos.

Esta prueba **solo certifica un procedimiento sintético en GitHub Actions si
la ejecución pasa**. No demuestra backups cifrados **fuera de Kali**, acceso a
copias reales, recuperación de fotos originales, claves operativas, tiempos RTO/RPO
ni la restauración de una base productiva desidentificada. Por tanto,
**F2.03 permanece [ ]**, hasta evidencias reales y aprobación separada.
No copiar claves ni subir respaldos a artefactos públicos.

## F2.02 — Atestación Kali vs GitHub
Requerido: versión, SHA Git y hashes de API+worker, imagen, Compose, Alembic y rollback, solo lectura, sin secrets ni cambios de infraestructura. En standby mientras no hay acceso a Kali. Issue #1.

## F2.03 / F2.04 — Backup/restore y rollback
Requerido: PostgreSQL+volumen de media cifrados **fuera de Kali**, digest/sello, capacidad de descifrado y restauración confirmada, objetos media existentes e integridad de ledger; ensayo API/worker anterior vs candidato (fallo de migración, incompatibilidad de esquema, Redis ausente) sin downgrade automático de Alembic ni destruir ledger. Laboratorio sin datos de clientes.

## F2.05 / F2.06 — Disponibilidad y observabilidad
La consulta externa previa recibió HTTP 403. Es una respuesta HTTP, **no prueba de que el backend esté caído**. No cambiar WAF global ni permitir accesos indiscriminados. Debe existir 200+JSON `ready/database/redis=true` desde otra red y un monitor 24/7 con alerta realmente entregada a una persona de guardia, no solo un cron activado. Issue #21.

## F2.07 / F2.08 — Proveedores TEST (NO LIVE)
- Stripe TEST: crear PaymentIntent, webhook verificado y duplicado/fuera de orden, captura/settlement, refund parcial/completo, disputa, expiración, intermitencia y replay; conciliar IDs contra ledger, no basta fixture falso.
- Mercado Pago sandbox: checkout real de prueba, firma webhook válida, repetidos, rechazo, refund/dispute y conciliación.
- Stripe Connect TEST: onboarding de cuentas restaurante/repartidor, verificación KYC, destino bancario ficticio, webhook Connect, payout/transfer simulados con prueba de fondos y reintentos.
- Documentar qué capacidades de Connect están **efectivamente habilitadas para cuentas mexicanas**. No suponer posibilidad de retirar fondos solo porque existe endpoint en el SDK.
- Nunca copiar claves TEST/LIVE a GitHub Issues, PRs o artefactos. Secrets TEST con mínimo privilegio únicamente cuando estén disponibles.

## F2.09 / F2.10 — Economía de saldos y efectivo
Separar ingreso cobrado al cliente, custodia PSP/banco, saldo comprometido, propina, salario del repartidor, cuenta por pagar de restaurante, dinero disponible para payout y conciliación bancaria. El ledger actual `financial_ledger_entries` es un registro *de expectativas contables*, no prueba de que el dinero entró al banco.

**Efectivo físico**: quien lo recauda debe figurar en la operación y tener un saldo auditable; netting automático solo con payouts digitales confirmados del MISMO beneficiario. Si saldo insuficiente, limitar **futuros** pedidos de efectivo sin afectar entregas activas; no declarar ingreso bancario ni un recibo pagado por una simulación. Cuenta, PSP, consentimiento y mandato MX aún por validar. Issue #24.

### Avance de laboratorio F2.09 — conciliación solo lectura, NO fondos disponibles

El gate `backend/qa/phase2_reconciliation_readonly.py` consulta con transacción
PostgreSQL READ ONLY las tres órdenes sintéticas creadas por F2.11, verificando:
importe total exacto, cuentas por pagar al restaurante/repartidor, propina de
delivery, ingresos plataforma, moneda MXN, dirección/kind del asiento y claves
de idempotencia únicas. Valida efectivo y Mercado Pago sintéticos. Regresiones
adicionales comprueban fraude contable por duplicados, cifras alteradas, propina
perdida, reembolso no conciliado, divisas distintas y estado local 'paid'.

**Regla explícita**: el reporte solo puede devolver `NO_GO_LEDGER` o
`PENDING_EXTERNAL_EVIDENCE`, con `payout_authorized=false`; ningún asiento,
GMV o `payment_status=paid` acredita que PSP/banco tenga el dinero. El script
NO consulta redes ni cambia cuentas, saldos, tablas, endpoints o producción.

Esto añade cobertura técnica sobre F2.09, pero **no cierra F2.09**:
faltan reconciliación real por PSP/identificador y beneficiario, custodia bancaria,
reembolsos/contracargos, saldos reservados, cash netting y autorización independiente.
Solo declarar PASS del nuevo gate cuando GitHub Actions termine exitosamente.

## F2.11 — Certificación comercial de política 1.6.2
- 15% comisión sobre productos netos; 7% del subtotal neto para el cliente tanto tarjeta como efectivo, tope $25.
- Envío $35 para primeros 2 km; +$5 por km/facción proporcional. Repartidor $32 primeros 2 km; +$4 por km/facción proporcional.
- Propinas del delivery 100% en payable repartidor y del pickup 100% en payable restaurante. No aplicar comisión a propinas.
- Checkout y ledger deben cuadrar con proveedor `cash`, `mercadopago`, `stripe` (Stripe en QA **solo con placeholder**, nunca con credenciales reales).
- [`backend/tests/test_phase2_pricing_ledger_contract.py`](../backend/tests/test_phase2_pricing_ledger_contract.py) prueba contratos contra SQLite sintético, y [`qa.phase2_pricing_pg_smoke`](../backend/qa/phase2_pricing_pg_smoke.py) contra PostgreSQL efímero y Redis.
- **Importante:** `COMMERCIAL_PRICING_V162_ENABLED` está **false por defecto** en código. Su activación efectiva en Kali no puede asumirse por CI, ni debe cambiarse desde esta PR. El contrato PASS de laboratorio no certifica pricing LIVE hasta atestación F2.02.

## F2.12 — GO/NO-GO formal

| Comprobación | Evidencia requerida | Estado actual |
|---|---|---|
| Código/tag release fijados | SHA Git + seis checks PASS + rollback documentado | Fase1 RC PASS técnico, sin desplegar |
| Versión Kali efectiva | atestación API/worker/Alembic/Compose | PENDIENTE |
| Reconciliación bancaria real | transacción con identificador y confirmación PSP/banco | PENDIENTE |
| Checkout/Refund/Disputa PSP TEST | webhooks firmados, duplicados, reintento, out-of-order | PENDIENTE |
| Connect TEST beneficiarios | KYC, banco, transfer/payout, pruebas de error | PENDIENTE |
| Backup+Restore PG/media | prueba recuperable cifrada fuera de Kali | PENDIENTE |
| Cash ledger/netting | previas read-only idempotentes, límites, consentimiento | PENDIENTE |
| Alertas 24/7 | alerta realmente recibida | PENDIENTE |
| Contratos/privacidad/fiscalidad MX | revisión de responsable jurídico y contable | PENDIENTE |
| Aprobación humana específica | responsable, fecha, PSP, cuentas, moneda, topes, rollback | **NO CONCEDIDA** |

**Decisión invariable de esta auditoría: NO-GO** para Stripe LIVE, payouts, transferencias y cobros reales automáticos nuevos. Solo un proceso externo con evidencia verificable, firmantes autorizados y despliegue aprobado puede cambiarla.

**En esta PR no se crean cuentas bancarias, no se hacen transferencias, no se actualizan `.env.production` ni se ejecutan migraciones de Kali.**
