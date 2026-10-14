# TALA EATS — Checklist P0 5–8: evidencia y procedimiento de cierre

**Fecha:** 14/oct/2026 UTC. **Estado:** laboratorio completo; PROD NO CERTIFICADO.
**PR:** [#20](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/pull/20) (draft, base #19), sin merge y SIN deploy a Kali.

## 5. Backup y recuperación

[GitHub Actions PASS](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38510250338)
- PG16 `pg_dump -Fc` real, `pg_restore --exit-on-error` sobre otra base efímera.
- Esquema, 68 tablas, 129 registros sintéticos, triggers, Alembic `f21i00000001` y digest canónico de registros idénticos.
- Archivo tar de 2 medios SINTÉTICOS recuperado con SHA-256 idéntico.
- Nadie subió respaldos ni datos a GitHub.

**Pendiente PROD:** snapshot de PostgreSQL REAL y medios con cifrado, almacenamiento fuera de Kali y política de retención; restauración sobre servidor independiente, tiempo RTO medido, lag de backups para RPO, prueba de que WAL/PITR funciona si se activa. Nunca restaurar encima de producción para probar.

## 6. Carga y fallos

[GitHub Actions PASS](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38510251905)
- Docker con **dos workers** de Uvicorn, PostgreSQL16 y Redis8 efímeros, sin Stripe.
- 120 GET concurrentes a 12 trabajadores, 0 errores HTTP, **p95=241 ms** en un runner de GitHub (no es medida de capacidad LIVE).
- Redis pausado: `GET /ready` devuelve HTTP 503; al recuperarse responde HTTP 200.
- No prueba al mismo tiempo fallas reales de PostgreSQL, memoria bajo carga, pedidos concurrentes de centenares de usuarios, webhook throughput ni multi-servidor.

**Pendiente PROD:** umbrales acordados con piloto 10 restaurantes/300–600 pedidos mensuales, escenario 200 pedidos/día, crecimiento escalonado, circuit breakers y reportes de capacidad en staging semejante a Kali. No afirmar capacidad 1000 pedidos/día.

## 7. Alertas, monitoreo y rollback

[Alerta sintética y resolución PASS](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38510250338): se creó una alerta crítica por outbox, se encoló correo para ADMIN, se resolvió al desaparecer el backlog. **Se probó la cola, NO el envío real del correo**.

[Rollback de imagen PASS](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38510251905): se detuvo el contenedor candidato y se arrancó la imagen base anterior en el mismo puerto de laboratorio; `/ready` regresó 200; ninguna migración real se revirtió.

[Monitor público desde GitHub FAIL](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38510207933): no se pudo consultar `/api/v1/ready` desde el runner; ver [issue #21](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/21). No asumir caída de Kali sin confirmar.

**Pendiente PROD:** resolver acceso de /ready externo, probar entrega de alertas a personas de guardia, configurar on-call, observabilidad y alertas de 5xx, p95, pagos sin conciliar, outbox/DLQ, worker heartbeat, pedidos atascados y saldo de retiros. Simular rollback real de despliegue sin revertir a ciegas migraciones destructivas, cifrar backups y documentar responsables.

## 8. E2E Usuarios — Restaurante — Repartidor — ADMIN

[Contrato API 4 roles PASS](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38510250338): cuatro logins distintos, restricciones de acceso por rol, pedido en efectivo de datos sintéticos, cambio de restaurante confirmed→preparing→ready, asignación automática a driver, picked_up→on_the_way, comprobación de PIN, entrega y actualización visible desde ADMIN. Un solo pedido y una prueba de entrega.

**Pendiente PROD:** flujo instalado en los tres teléfonos Flutter y portal ADMIN, fotos reales controladas, notificaciones push, recuperación de fallas de red, pagos y webhooks contra Stripe TEST externo, liquidaciones / disputas / refund TEST, GPS y pruebas de aceptación con restauración en staging. No usar pagos LIVE para QA.

## Estado honesto del checklist global

- [ ] 1. GitHub idéntico a Kali LIVE: **PENDIENTE acceso laptop**
- [x] 2. Seguridad + suite CI sobre un commit: **PASS de laboratorio** (#19)
- [x] 3. Doble checkout PostgreSQL sin duplicado: **PASS del escenario probado**, escenarios de Redis caído y multiworker checkout pendientes
- [ ] 4. Stripe TEST externo, webhooks y conciliación: **PASS de lógica simulada; PENDIENTE Stripe TEST real**
- [ ] 5. Backup restaurado desde datos productivos (sanitizados): **PASS sintético solamente**
- [ ] 6. Carga realista en staging: **PASS microcarga 120 GET; pendiente presión sostenida**
- [ ] 7. Monitor/alertas entregadas y rollback real: **PASS simulado; monitor externo FAIL**
- [ ] 8. E2E físico móvil/ADMIN y pagos TEST: **PASS API 4 roles; pendiente dispositivo y proveedor**

**Nunca escribir PROD PASS hasta probar los 8 objetivos en sus entornos correspondientes.** No acceder a Kali/Stripe LIVE desde GitHub CI. Exigir aprobación humana para cualquier cambio de infraestructura y release.

## Guía de operación tras recuperar acceso a Kali

1. Validar hashes de código y `/ready` con `scripts/attest_kali_live_readonly.py`; si hay discrepancias, registrar antes de merge/deploy.
2. Verificar política de backup PostgreSQL16 + volúmenes `media`, test restore SANITIZADO en staging distinto; medir RPO/RTO.
3. Revisar Cloudflare Tunnel, Caddy y DNS para el monitor externo y verificar notificación de alerta humana.
4. Certificar E2E con Stripe TEST y apps instaladas, sin mezclar credenciales/test con Stripe LIVE.
5. Solo después plan de despliegue: backups verificados, check de migración, tag inmutable, aprobación humana, rollback de imagen, health + conciliación postdeploy. Jamás `alembic downgrade` ciego.

**Línea base:** trabajo GitHub aislado de producción; las últimas cuatro áreas se implementaron y validaron parcialmente, pero no es honesto declarar producción apta hasta su certificación real.
