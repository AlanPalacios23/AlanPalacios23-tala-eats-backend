# TALA EATS — Checklist 1–4, corte de QA aislado

**Fecha:** 13/oct/2026 (México). **Estado:** release candidata validada en CI; falta atestación física de Kali y E2E con Stripe TEST real. NO SE DESPLEGÓ NADA.

**Candidato integrado:** Pull Request #19 (draft): https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/pull/19

**SHA exactamente probado:** `8b42f36d8ae15af9d232f38b2ff02aab30912fbb`.

## Evidencia CI sobre el mismo SHA

1. FastAPI + SQLite + Stripe firma HMAC sintética: [QA](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38508537559) **218/218 PASS**, 8 advertencias.
2. PostgreSQL16 + Redis8 + Alembic + concurrencia real: [Postgres](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38508537563) **PASS**. Primer intento detectó error UNIQUE durante flush, corregido; dos solicitudes simultáneas idénticas ahora producen un pedido, un decremento de inventario y un evento outbox.
3. pip-audit y Bandit: [Security](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38508537542) **PASS**, sin vulnerabilidades conocidas declaradas para dependencias de ese SHA.
4. Docker: [Container](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38508537603) **PASS**, compilación y usuario no-root, sin publicar imagen ni conectarse a Kali.

## Checklist original

### 1. Código GitHub idéntico a versión LIVE de Kali
**PARCIAL.** Herramienta read-only disponible en main: `scripts/attest_kali_live_readonly.py`.

Ejecutar **EN KALI**, para comparar primero `main` (snapshot PREDEPLOY) con el contenedor actual, sin cambiar nada:

```bash
gh repo clone AlanPalacios23/AlanPalacios23-tala-eats-backend ~/tala-backend-audit
cd ~/tala-backend-audit
git switch main
python3 scripts/attest_kali_live_readonly.py \
  --ready-url https://talaeats.alan-palacios-dev.com/api/v1/ready
```

La prueba solo inspecciona estado HEALTHY, compara SHA-256 de código (app/, migrations/, requirements.txt, entrypoint.sh) contra `/app` del Docker activo y consulta `/ready`. **No accede a .env ni dump SQL, y no reinicia servicios**.

Si reporta mismatch: NO desplegar, investigar qué fuente tiene el contenedor. Si se ejecuta desde la rama candidata #19, las discrepancias con LIVE son esperables por cambios intencionales, por lo que primero debe compararse la versión original en `main`.

### 2. Seguridad y suite completa PASS sobre un solo commit
**PASS DE CI.** El PR #19 combina #14 y #15 y todas las herramientas auditan el mismo SHA. **No merge**, sin revisión de compatibilidad de la release candidate frente a producción ni aprobación de deploy.

### 3. Pedidos concurrentes sin duplicación
**PASS del escenario verificado:** dos operaciones independientes simultáneas en PostgreSQL, misma referencia, misma compra, stock y outbox solo una vez. **Pendiente antes del piloto:** caída de Redis, timeout justo después de commit, cliente que genera una referencia nueva y multitrabajador real bajo carga.

### 4. Stripe TEST, reembolsos y conciliación
**PASS del contrato aislado** usando SDK Stripe real con firma HMAC sintética, firma incorrecta rechazada, livemode incorrecto rechazado, webhook duplicado reconocido, refund parcial/total y ledger sin duplicaciones, más refund ADMIN idempotente. Las pruebas no contactan Stripe externo.

**Stripe TEST externo aún NO certificado.** Existe un flujo manual `.github/workflows/backend-stripe-test-manual.yml` en PR #19, con guardia que solo acepta una clave `sk_test_`; hará PaymentIntent de prueba y refund idempotente en Stripe sandbox, sin dinero LIVE. Antes de poder ejecutarlo, debe publicarse la herramienta tras revisión y configurar en el GitHub Environment `stripe-test` el secreto `TALAEATS_STRIPE_TEST_SECRET_KEY`. **Nunca escribir claves en tickets, chats, archivos o commits.** Un pago REAL LIVE no es parte del QA.

## Recomendación de cierre
No declarar Production Ready ni fusionar automáticamente PR #19. Certificar origen LIVE, completar prueba Stripe TEST proveedor y QA E2E del backend en staging. Seguimiento:
- https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/1
- https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/3
- https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/18
