# TALA EATS — Python completo → Node nativo; continuidad Kali

**Decisión del propietario (19-oct-2026):** reproducir **todo** el comportamiento público/privado del Python existente antes de sustituirlo por Node.js 24 + Express/TypeScript + Prisma 7 + PostgreSQL 15 + Redis 8 + BullMQ + PM2. No es un MVP simplificado. Mantener las tres apps Flutter y el portal ADMIN compatibles.

> **AVISO 21/22-oct-2026 — documento histórico.** Desde que se redactó este plan, el operador confirmó Node RC6 por PM2 y su publicación por Cloudflare (`https://talaeats.alan-palacios-dev.com/api/v1`) y eliminó los seis contenedores Docker Python `talaeats-v3`, preservando sus respaldos y volúmenes. **La URL responde desde staging** (`productionReady=false`, `financialWrites=false`): no demuestra paridad funcional, migración de datos ni aptitud para uso comercial. Ver [bitácora operativa RC6](KALI-NODE-RC6-PUBLIC-API-AND-LEGACY-RETIREMENT-20261022.md) antes de usar instrucciones de este plan.\n\n## Fuente canónica e inventario verificable

- Python `main@7cf8ae3f4fce51b1265ad511bd4e36077fc42636` es el punto inicial de comparación, no una autorización para congelar futuras mejoras. Reconciliar contra el nuevo `main` antes de cada release.
- 16 módulos, 252 decoradores de rutas HTTP; ejecutar `python3 node-backend/scripts/python_route_inventory.py --check`. Para inspección mecánica: agregar `--json`. Es análisis AST, sin levantar Python, DB, web ni pagos. Ver `PYTHON-TO-NODE-PARITY-MATRIX.md`.
- Inventariar también rutas fuera de esos módulos: WebSocket, health/ready, tareas periódicas, workers, migraciones, contratos de archivos, webhooks, callbacks y políticas de permisos. **252/252 no será suficiente por sí solo.**
- Cada endpoint requiere fixture de petición/respuesta, códigos HTTP, RBAC, validaciones, idempotencia, transacciones, errores, caché y efectos laterales. No contar "ruta con igual nombre" como PASS.

## Entregas técnicas en orden (sin sustituir producción)

1. **Identidad:** registro/login/logout, sesiones/dispositivos, TOTP/2FA, recuperación de contraseña con outbox y SMTP, Google ID Token validado, riesgo/fraude, RBAC y auditoría. Actualmente PR #81 DRAFT; CI PG15/Redis8 verifica subconjunto sin servicio real de email/OAuth.
2. **Catálogo/localidad:** comercios, horarios, stock, menús, productos y variantes que respete Python, búsqueda y filtros por mercado (Tala piloto; después Ameca, Ahualulco de Mercado, Tequila, Cuisillos y Amatitán).
3. **Pedidos:** client_reference por usuario, reserva de inventario, doble toque, reintentos, recuperación tras reinicio, estados, cancelaciones, reorden, eventos/outbox. Exactitud monetaria con DECIMAL y transacciones.
4. **Restaurante y repartidor:** perfil y geolocalización, aceptación de órdenes, KDS, disponibilidad, asignación/dispatch, prueba de entrega, PIN, ganancias y permisos.
5. **ADMIN/operaciones:** reglas RBAC, privacidad, documentos, notificaciones, soporte, auditoría, límites de tasas, observabilidad y borrado/retención.
6. **Pagos/finanzas/resiliencia:** efectivo y merchant-managed, Stripe TEST y Mercado Pago sandbox, webhooks firmados, deduplicación, reversos, conciliación, ledger inmutable, retiros controlados, DLQ y recuperación. NO usar LIVE para probar paridad.

Cada entrega: PR separada, SHA y CI verde, pruebas negativas de seguridad, migración incremental SOLO en PG15 staging aislado, pruebas contractuales de apps y documentación de discrepancias.

## Lo que ya existe en Kali según evidencias operativas anteriores

- Usuario dedicado **`tala-node-stage`** y código en `/home/tala-node-stage/talaeats-node-source`.
- Node 24/PM2: API loopback `127.0.0.1:18190`, PostgreSQL nativo 15.19 `127.0.0.1:15435` y Redis 8 `127.0.0.1:16379`. La base aislada se llama `tala_node_stage`.
- PM2 API+worker, `/ready` saludable en una prueba anterior, backups/restore sintético aislado y tres unidades systemd de usuario preparadas/habilitadas según el último estado informado. No confundir esas evidencias con una inspección remota actual ni con garantía de reboot completo.
- PR #80 contiene infraestructura Node; PR #81 se apila sobre #80. PR #79 es un agente de despliegue del Python y **no se reutiliza** como CD de Node.

## Política para cambios en Kali

**Etapa 1 — Ahora:** GitHub CI y staging Node privado. Los comandos que cambien código, Prisma, systemd o PM2 sólo operarán en el usuario `tala-node-stage`, por SHA aprobado y con preflight. Confirmar usuario, rutas, puertos y versionado; respaldar DB staging y verificar restauración antes de cualquier migración. **Las migraciones no se ejecutan automáticamente al arrancar.**

**Etapa 2 — Paridad:** Desplegar cambios Node primero únicamente a loopback 18190/PG15 15435/Redis 16379, sin tocar el backend Python, bases GREEN/V3, Docker, Caddy, Cloudflared, `.env.production`, bancos, Stripe LIVE, cobros ni retiros. Probar respuestas reales y compatibilidad con cada cliente; validar que datos sintéticos no llegan a LIVE.

**Etapa 3 — Preparación de cambio público:** Diseñar adaptación/migración de datos Python→Node a partir de copia **desidentificada**, reconciliar esquema y ledger y medir backup/restauración/rollback. Comparar contratos de los cuatro clientes con el mismo SHA final de Node; comprobar seguridad, fallos DB/Redis, cola, correo, pagos TEST y carga. Confirmar acceso/SSH y procedimiento de recuperación.

**Etapa 4 — Cutover separado:** Sólo si todos los gates están completos, con aprobación operativa explícita y ventana de mantenimiento, cambiar el proxy/túnel hacia el Node validado. Mantener reversión rápida y pruebas externas. Nunca inferir que fusionar PR #80/#81 o ver CI verde modifica por sí mismo Kali ni redirige el tráfico.

## No-Go obligatorio

- Falta cualquiera de los contratos operativos, permisos, estados o efectos financieros de Python.
- Faltan backup y restore **del entorno que se va a migrar** con prueba de ledger/integridad.
- Hay regresiones en Usuarios, Restaurante, Repartidor o ADMIN, y no se probó recuperación de pedidos/reintentos.
- Cualquier prueba Stripe LIVE o payout LIVE no aprobada expresamente.
- Una ruta pública/DNS apunta a Node antes de paridad.
- No existe forma verificada de entrar en Kali y deshacer exclusivamente la actualización Node.
- La evidencia se basa sólo en CI o documentación y no en el runtime real de staging.

**Estado actual:** inventario/CI y parte de Auth avanzan; la sustitución de Python **sigue NO-GO**. Esta política autoriza trabajo incremental en repositorio/staging protegido, **no** despliegue productivo implícito.
