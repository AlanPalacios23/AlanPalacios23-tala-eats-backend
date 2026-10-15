# TALA EATS — Dictamen de control financiero (F2.12)

**Edición:** 15/oct/2026. **Clasificación:** preparación operativa; sin secretos, sin datos bancarios ni información personal. **Decisión a la fecha: NO-GO PARA LIVE**. La elaboración de un protocolo y su aprobación efectiva son cosas distintas.

## 1. Alcance, autoridad y segregación de funciones

No hay autorización para crear ni mover dinero en producción por esta propuesta. Ninguna combinación de CI verde, captura, archivo de configuración o script se considera permiso de ejecución bancaria.

| Función responsable | Decide / certifica | No puede autoconcederse |
|---|---|---|
| Responsable técnico de release | SHA Git y digest Docker, migraciones, E2E, ventana, plan de reversión | GO financiero ni alteración de saldos |
| Responsable de finanzas y conciliación | Evidencia bancaria y PSP, saldos por orden/beneficiario, reservas, límites y margen | Modificación unilateral de identidades bancarias |
| Responsable de seguridad/incidentes | KYC, 2FA, antifraude, llaves y accesos, alertas, contingencias de fraude | GO financiero sin conciliación |
| Responsable jurídico/fiscal mexicano | Contratos de restaurante/repartidor, privacidad, impuestos, flujos de recaudación y autorización | Declarar liquidaciones «pagadas» sin evidencia |

Antes de LIVE, cada función debe tener **persona designada** por la empresa y ticket interno de revisión. Ninguna está designada por este documento. La aprobación final debe ser **explícita, humana y específica** por proveedor, cuenta, ambiente, fecha, versión, beneficiarios y topes. Si una persona desempeña más de una función, es obligatorio un segundo aprobador independiente para desembolsos.

## 2. Evidencia obligatoria para recibir un dictamen

**Cada punto requiere un vínculo a un artefacto/ticket interno verificable**, autor responsable, fecha, resultado y caducidad de la evidencia si aplica. No incluir contraseñas, claves, CLABE, fotografías de identificación ni números completos de cuenta.

1. Release de código exacta (SHA de 40 caracteres, digest imagen, seis CI PASS, versión efectiva Kali).
2. Restore de backup **cifrado y fuera del host** PostgreSQL + media, con suma de verificación e integridad ledger; evidencia de tiempo objetivo de recuperación.
3. Despliegue y rollback ensayados en staging con esquema y workers compatibles, incluyendo fallos del proceso de migración.
4. Endpoint público 200/JSON `ready/database/redis=true` desde red externa con Caddy/Cloudflare y WAF intactos; alerta 24/7 recibida realmente por la guardia.
5. Stripe TEST y Mercado Pago sandbox: cobro, reembolso, expiración, firmas webhook, repetición/fuera de orden y dispute, conciliación de IDs.
6. Stripe Connect TEST: cuentas de restaurante y repartidor, KYC, banco ficticio, webhooks, simulación de transfer/payout/errores y confirmación de capacidades del proveedor en México.
7. Efectivo: ledger por repartidor colector, saldos exigibles, prevención de duplicados, netting solo contra créditos conciliados del mismo titular, límites de exposición, **preview sin escritura**.
8. Conciliación por orden/beneficiario: **no inferir dinero disponible desde GMV, ingresos estimados o saldo proyectado**. Evidencia de proveedor/banco, fees reales y reservas netas antes de payout.
9. Aviso de privacidad, contratos, responsabilidades de comercio/driver, impuestos, devoluciones y mandato legal de manejo de fondos revisados en México.
10. Límites piloto escritos y autorizados: máximo por retiro, máximo diario por beneficiario, límite de efectivo sin conciliar, fondo de reembolsos/disputas y criterios de suspensión. No se fijan valores ejecutables aquí.

## 3. Fraude, devoluciones y disputas — respuesta formal

| Señal o evento | Prevención y acción requerida | Criterio de NO-GO / pausa |
|---|---|---|
| Destino bancario cambiado, nuevo dispositivo, OTP repetido | 2FA, vinculación de cuenta por titular, cooldown, verificación proveedor, evento auditable, doble validación para cambio crítico | Cualquier cuenta no verificada o cambio en revisión |
| Pago confirmado localmente pero no en proveedor | marcar `pending_reconciliation`, reconsultar PSP, nunca disponibilizar para retiros | Conciliación no identificada o webhook inválido |
| Webhook repetido/fuera de orden | firma autenticada, `event_id` único, reserva/ledger idempotente, comprobación por PSP antes de mutaciones | Doble asiento o cambio irreversible sin prueba |
| Solicitud de devolución parcial o completa | validar identidad, motivo y límite; bloquear reserva del beneficiario, emitir refund por PSP con idempotencia, registrar asiento compensatorio, reconciliar resultado | Refund y payout del mismo importe simultáneos o proveedor incierto |
| Contracargo o disputa posterior a la liquidación | conservar historial, abrir caso, calcular deuda recuperable/reserva, detener payouts relacionados hasta resolución | Riesgo sin saldo para cubrir contracargos |
| Efectivo no depositado por repartidor | asignar deudor colector, límite de exposición, restringir futuras asignaciones de efectivo cuando corresponda, sin bloquear entregas en curso | Deuda sin conciliar mayor al límite autorizado |
| Falla de PSP/red/worker/DB/outbox/DLQ | suspender mutaciones, alerta a guardia, reconciliar transacciones pendientes antes de reintentar, usar claves idempotentes | Falta de observabilidad o desbalance |
| Discrepancia contable o riesgo AML | congelar payout afectado, investigar fuente, revisión jurídica y financiera, registro auditable de decisión | Cualquier saldo negativo no justificado |

**Riesgo residual:** ni los tests sintéticos ni una aprobación jurídica preliminar garantizan que la entidad bancaria haya recibido fondos. Se exige reconciliación externa por identificadores PSP/banco y fecha valor, sin declararlos «paid» a partir de una llamada API no confirmada.

## 4. Límites, ventana de operación y rollback

Los siguientes son campos obligatorios **sin valores de operación preaprobados**:

- `single_payout_max_mxn`: límite por retiro; `daily_payout_max_mxn`: acumulado por beneficiario y día, incluyendo reservas pendientes.
- `cash_exposure_max_mxn`: deuda física neta autorizada por colector, incluida deuda histórica; `dispute_reserve_mxn`: dinero reservado para devoluciones/disputas.
- Beneficiarios autorizados (referencias en proveedor, no CLABE), moneda MXN, entorno, fecha de inicio/fin, responsable de guardia, canal de emergencia, límites de reintentos/ventanas de espera.
- Plan de reversión del **código API y worker**, con incompatibilidades de Alembic identificadas. Ningún downgrade destructivo ni restauración que sobrescriba asientos financieros LIVE posteriores al respaldo.
- **Kill switch** operativo de la nueva ejecución financiera previamente ensayado y supervisado, con conciliación obligatoria de operaciones en curso al suspenderse.

## 5. Formato de decisión humana (no llenado)

| Campo | Valor para la aprobación real |
|---|---|
| ID ticket / Change Request | **Pendiente** |
| Release SHA / digest | **Pendiente** |
| PSP(s) y modo permitido | **Solo TEST actualmente** |
| Beneficiarios permitidos / cuentas verificadas | **Pendiente** |
| Límites por retiro/día, efectivo y reservas | **Pendiente** |
| Evidencia E2E, firma PSP, bank settlement | **Pendiente** |
| Plan de fraude, reclamaciones y guardia 24/7 | **Pendiente** |
| Responsable técnico y ticket firmado | **Pendiente** |
| Responsable financiero y ticket firmado | **Pendiente** |
| Responsable de seguridad y ticket firmado | **Pendiente** |
| Responsable jurídico/fiscal y ticket firmado | **Pendiente** |
| Fecha/hora, expiración, duración piloto | **Pendiente** |
| Dictamen | **NO-GO** |

Se requieren dos decisiones distintas: (a) integridad documental revisada por CI; (b) **aprobación humana fuera del repositorio** tras verificar las evidencias. El código jamás habilita LIVE por esta tabla.

## 6. Dossier de evidencia estructurada, solo lectura

`backend/qa/phase2_financial_gonogo.py` tiene un evaluador que solo comprueba **completitud** de un expediente JSON local, por ejemplo `python -m qa.phase2_financial_gonogo expediente_local_sin_datos_sensibles.json`. Sus resultados son exclusivamente:

- `NO_GO`: controles/firma de roles ausentes o datos incompatibles; código de salida 2.
- `REQUIRES_MANUAL_FINANCIAL_AUTHORIZATION`: todos los campos formales presentes; **no equivale a GO, ni verifica por sí mismo las pruebas ni permite dinero LIVE**.

El expediente usa referencias opacas a tickets internos (sin CLABE/credenciales), SHA verificado del código, límites piloto aprobados y el literal `live_execution_approved=false`. El evaluador ni siquiera tiene posibilidad de aprobar LIVE: cualquier `true` falla cerrado. Nunca pasar las credenciales reales como argumento, ni archivar expedientes con identidades en GitHub Actions. No crea alertas, pagos, cuentas, webhooks ni modifica configuración.

**Cierre del ítem F2.12:** este documento y su prueba automatizada completan la *elaboración de un protocolo formal*; la aprobación real permanece pendiente y se refleja en F2.07, F2.08, F2.09, F2.10 y en el GO/NO-GO de lanzamiento. En ninguna circunstancia marcarlo significa iniciar Stripe LIVE.

---
Revisión legal y financiera externa necesaria antes del piloto. Documento técnico sujeto a aprobación empresarial.
