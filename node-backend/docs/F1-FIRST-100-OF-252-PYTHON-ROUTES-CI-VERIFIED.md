# F1 — Primera meta Python → Node: 100/252 rutas HTTP coincidentes

**19 octubre 2026. Estado:** GitHub [PR #98](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/pull/98) DRAFT apilada sobre #97 → #96 → #94 → #92 → #89 → #88 → #87 → #86 → #85 → #84 → #83 → #81 → #80. Python fuente: `main@7cf8ae3f` (inventario de **252 rutas HTTP en 16 módulos**, excluye WS/workers/jobs).

## Evidencia exacta

- GitHub Actions **push SUCCESS** [39294073162](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/39294073162); **PR SUCCESS** [39294080865](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/39294080865). SHA de código verificado: `fd333314be376d0cc1faf4ceb4fccd581600fcbf`.
- Verificador `node-backend/scripts/node_route_coverage.py --json`: `NODE_EXPRESS_DECLARATIONS=100`, `NODE_PYTHON_STRUCTURAL_MATCHES=100`, `PYTHON_ROUTES_NO_NODE_DECLARATION=152`, **39.68% cobertura estructural** (método + path, no función ni igualdad absoluta de JSON).
- E2E aislados PostgreSQL15/Redis8: Auth, catálogo, checkout sintético cash/pickup, C2/C3/C4, restaurante D1, repartidor D2, plataforma E1/E2/E3/E4, y F1.
- F1 resultados: `NODE_F1_ADMIN_6_ROUTER_CONTRACTS_RBAC_PRIVACY=PASS`, `NODE_F1_OPERATIONS_9_REPORTING_ZONES_LEDGER_GATES=PASS`, `NODE_F1_V9_9_ETA_MARKETS_MENU_LOYALTY=PASS`, `NODE_F1_V10_3_HEALTH_RUNTIME_REAL_REDIS=PASS`, `NODE_F1_V11_8_READINESS_FAIL_CLOSED_PRIVACY=PASS`.

## Nuevo alcance F1 y limitaciones

| Origen Python | Rutas nuevas | Alcance E2E |
|---|---:|---|
| `/api/v1/admin` | 6 | métricas, listado protegido de cuentas/pedidos, fraude, verificaciones, wallet solo lectura |
| `/api/v1/operations` | 9 | zonas y cobertura por Haversine, flags por usuario, configuración ADMIN, command-center, finanzas, asientos históricos solo lectura |
| `/api/v1/v9` | 9 | catálogo de versión, status fidelidad, Plus estimado, ETA por estado, mercados/sucursales, horarios y precios menú, embudo, salud |
| `/api/v1/v10` | 3 | catálogo legado, runtime Redis real, estado DB/incidentes/driver |
| `/api/v1/v11` | 8 | catálogo legado, readiness sin GO-LIVE, proveedor integración deshabilitado, cohorte, config push deshabilitada, preferencias, contrato mobile, presupuestos |
| **Total nuevo** | **35** | **35 rutas invocadas por E2E** |

**Importante:** Algunas son endpoints de metadatos y otras operan sobre *funcionalidades restringidas* o información sintética. No declarar 100 funciones equivalentes o 39.7% del trabajo terminado: hay **152 HTTP pendientes**, además de workers, WebSocket, Stripe/MP, conciliación de pagos, cobros/reembolsos, KDS/reparto LIVE, datos geográficos/FCM, submódulos V9–V11, pruebas de apps Flutter y ADMIN, seguridad, benchmarks p95 y recuperación.

## No-Go y observabilidad

- `NODE_ENV=staging`, HOST=127.0.0.1, PG/Redis loopback segregados, `STRIPE_FINANCIAL_WRITES_ENABLED=false` y banderas de checkout/driver cerradas por defecto.
- V11 devuelve deliberadamente `core_ready=false`, `go_live.online_payments=false`, `go_live.automatic_payouts=false` y no declara integraciones privadas habilitadas. Catálogos de versión indican explícitamente que son **historia de capacidad Python**, NO features de Node LIVE.
- V10 `traffic.sampled=false` significa que el middleware de métricas todavía no mide tráfico real; **no** afirmar SLO o performance de producción.
- Varias consultas ADMIN/finance recorren entidades del laboratorio y todavía deben sustituirse por agregados SQL escalables, controles antiexfiltración y load tests antes de datos productivos.
- **Ningún cambio en Python/Kali/Gateway/DNS/Cloudflare o pagos reales, PR DRAFT sin merge.** La existencia de 100 rutas aisladas NO autoriza cutover.
- PR alternativas #93 y #95 solapan rutas y migraciones con la cadena canónica; **NO fusionarlas** junto con #92/#94/#96.

## Siguientes bloques útiles

1. Completar Motor Wallet real bajo proveedor **TEST**: canje atómico, ledger, idempotencia, gift cards y rewards; no transferencias reales sin controles.
2. Checkout delivery 1:1 Python + despacho Driver + realtime/outbox/FCM y pruebas Flutter Usuarios/Restaurante/Repartidor.
3. Migrar los 152 contratos restantes priorizando API ADMIN/operaciones (escrituras auditadas, retiros y pagos), V9–V11 y resiliencia, con controles de fuente Python.
4. Ensayar deploy en Kali **staging aislado** solo después de backup y autorización; comparar Python/Node con fixtures anonimizados; definir rollback verificable y gates GO/NO-GO.

Seguimiento persistente [checklist #82](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/82).
