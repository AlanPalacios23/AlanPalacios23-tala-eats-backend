# TALA EATS Backend — Auditoría y cierre de Issues (15 octubre 2026)

**Fuente verificada:** Issues y PR en GitHub, ejecuciones de Actions reales. El estado no es equivalente a aprobación para producción.

## Cerrado

| Issue | Resultado | Qué sigue fuera del alcance |
|---|---|---|
| [#2](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/2) — Infraestructura QA PostgreSQL 16 / Redis 8 | **CERRADO como entrega del laboratorio base:** workflow `.github/workflows/backend-postgres-redis.yml`, PG16+Redis8 efímeros, migración Alembic, checks de roles, Redis/idempotencia; [run 38707539433](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38707539433) PASS y [finance QA 38707539572](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38707539572) PASS. | Estrés/retries post-commit en [#18](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/18), Stripe TEST E2E en [#3](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/3), migraciones/rollback productivos en [#17](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/17); regresión PostgreSQL después de merge #40 aún sin prueba. |

## Abiertos por criterios todavía no satisfechos

| Issue | Avance confirmado | Evidencia que falta para cerrarlo |
|---|---|---|
| [#1](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/1) — GitHub vs Kali | Script de atestación disponible en rama #19 | Leer hashes de archivos/release/imagen y versión realmente en ejecución **en Kali** sin secretos, comparar contra SHA de GitHub; ninguna atestación confirmada |
| [#3](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/3) — 3 apps / pedidos y pagos | PG/Redis laboratorio, #40 fusionada a main | E2E 4 roles con 3 apps Android, checkout de recuperación, precios, reembolso y Stripe TEST real; ver [mobile #1](https://github.com/AlanPalacios23/tala-eats-mobile/issues/1) |
| [#17](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/17) — Operación, migraciones y rollback | Pruebas de backup, media, Redis y rollback en rama de laboratorio #19, [run 38510251905](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38510251905) PASS | Deploy plan independiente de migrations, copia sanitizada PG16 y comprobación Kali vs GitHub, restauración productiva verificable |
| [#18](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/18) — Exactly-once | Clave, colisión 409 y un descuento de stock en PG/Redis; PR #14 aún DRAFT | Simultaneidad real multiworker; Redis perdido después de COMMIT; reintento de app con misma referencia [mobile #7](https://github.com/AlanPalacios23/tala-eats-mobile/issues/7); webhook Stripe TEST fuera de orden |
| [#21](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/21) — Monitor /ready externo | 4/4 unittest PASS; diagnóstico **real desde Windows** [run 38779316555](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38779316555): **HTTP 403** | Identificar Cloudflare/Tunnel/WAF/Caddy/origen sin desactivar seguridad, lograr HTTP 200+JSON y probar entrega real de alerta; workflow temporal eliminado |
| [#22](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/22) — GPS fresco privado | PR #40 fusionada a main, Windows [253 PASS](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38771425138) | E2E Android/Repartidor en segundo plano, Redis cae, reasignación y 30+ consultas, PG16 Redis8 del nuevo SHA; [mobile #4](https://github.com/AlanPalacios23/tala-eats-mobile/issues/4) |
| [#23](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/23) — FCM | PR #40 y avisos obsoletos en main; pruebas sintéticas PASS | Proyecto Firebase y server credentials fuera de GitHub; FCM en Android cerrado/bloqueado/Doze, rotación tokens, opt-out y consentimiento |
| [#24](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/24) — Liquidación cash automática | PR #42 fusionada **solo a rama #29**, tests GO/NO-GO [25/25 PASS](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38774292373); **no mueve dinero** | Ledger/netting de fondos reales, PSP apto MX/contratos/consentimiento, reconciliación bancaria, disputas/refunds, E2E y QA predeploy; feature flags LIVE OFF |

## Decisiones y protección operativa

- **Issues cerrados en esta auditoría:** #2. Se cerró como infraestructura entregada, no como certificación de todos los escenarios de pagos.
- **Issues que no se deben cerrar por un simple PASS de unit tests:** #1, #3, #17, #18, #21, #22, #23 y #24. Cada uno tiene pasos externos/operativos sin verificar; se dejaron comentarios con los bloques específicos.
- **Código productivo:** `main` incluye GPS y FCM del merge #40; #19 y #29 siguen DRAFT y no están integradas a main.
- **Monitoreo:** HTTP 403 externo no equivale a backend down; averiguar origen antes de permitir tráfico, y mantener monitor manual hasta tener alerta 24/7 confiable.
- **Pagos:** NO-GO, sin autorización para pagos/transferencias/retiros LIVE. No se tocó Kali, banco, cuenta PSP ni secretos.
- **CI:** runner propio Windows; el workflow `backend-batches-windows.yml` debe permanecer solamente manual. No usar hosted minute-intensive cron sin decisión.

## Próxima secuencia recomendada

1. **#21 + #1**: diferenciar Cloudflare 403 de origen y atestar Kali por solo lectura; requiere datos reales del servidor/Cloudflare (no pueden inferirse de CI).
2. **#22 + #23**: instalar APKs de staging y demostrar GPS/FCM en dispositivo Android, con una configuración Firebase TEST segura.
3. **#18 + #3**: completar reintentos y webhooks aislados, crear evidencia E2E con 3 apps.
4. **#17 + #24**: revisión de migraciones y backup/rollback de release, contrato financiero/PSP local y QA integral antes de cualquier money movement.

El cierre restante se realizará sólo después de evidencia que realmente satisfaga su propia lista de aceptación.