# TALA EATS · RC8.9 — Entrega a postdespliegue en Kali (24 de octubre de 2026)

**ESTADO: propuesta técnica en GitHub; no instalada; sin autorización LIVE ni transferencias.**  
Base encadenada: RC8.6 → RC8.7 pickup/contabilidad (#146) → RC8.7 delivery (#149) → RC8.8 sincronización y reintentos (#152) → **RC8.9 postdespliegue**.

## Límite del despliegue

RC8.9 añade comprobaciones **exclusivas de STAGING**. Nunca convierte por sí mismo una plataforma en lista para producción, no activa envío con Stripe, cobros LIVE, Connect ni notificaciones Firebase. Conserva `tala-node-stage-api` y `tala-node-stage-worker`, 127.0.0.1:18190 y el Cloudflare ya existente; no crea otro servidor en conflicto. La aplicación que siga apuntando al backend público sólo debe usar funcionalidades publicadas como disponibles por él. La bandera `STAGE_DELIVERY_CASH_CHECKOUT_ENABLED` permanece **false por defecto**.

## Prepromoción: sólo revisión

1. Registrar SHA exacto de la rama aprobada **después** de la última prueba. Comprobar que no hay archivos modificados; no asumir que `main` contiene RC8.9 (sigue el Python histórico).
2. Preparar la carpeta con el mismo SHA en `/home/tala-node-stage/tala-node-releases/<SHA>/node-backend`. No reutilizar la carpeta de una versión activa.
3. Ejecutar gates locales/CI para `npm ci`, Prisma `generate/validate`, `npm run build`, `npm test`, inventario 252 rutas, CI E2E PG15/Redis8, y restauración en PostgreSQL desechable.
4. **No ejecutar ningún comando `--apply` sin autorización específica.** Revisa primero, como usuario `tala-node-stage`, la operación de sólo lectura:

```bash
cd /home/tala-node-stage/tala-node-releases/<SHA>/node-backend
bash scripts/rc8-kali-public-pm2-upgrade.sh --plan <SHA>
```

Si el plan no pasa, **HOLD**. No alterar directorios o variables para “forzar” la prueba. Si se autoriza un despliegue staging independiente, usar el promotor existente con respaldo, prueba de restauración y rollback; no ejecutar migraciones en caliente.

## Postdespliegue RC8.9 — auditoría estrictamente de lectura

*Sólo cuando la versión y el SHA estén realmente instalados en PM2,* ejecutar desde la cuenta `tala-node-stage`:

```bash
cd /home/tala-node-stage/tala-node-releases/<SHA>/node-backend
bash scripts/rc89-stage-postdeploy-check.sh <SHA>
```

El wrapper comprueba primero Node 24, UID, directorio SHA y archivo staging secreto (`0600`) y utiliza `node --env-file` sin evaluar código shell. No imprime claves ni tokens.

El auditor reutiliza `rc8-postdeploy-audit.mjs` y comprueba:

- Dos procesos PM2 exactos, online y apuntando al mismo SHA de código limpio; API y worker obligatorios.
- `/health`, `/ready`, `/payments/config` y `/payments/stripe/config` en localhost **y** dominio público, con contrato de staging y sin cargos ni fondos LIVE.
- `/orders/payment-methods` debe rechazar acceso anónimo en localhost y dominio público; no usar una sesión real ni crear pedidos de prueba durante el smoke.
- Heartbeat normal del worker independiente del HTTP.
- Si la funcionalidad experimental de domicilio está habilitada explícitamente en staging: heartbeat Redis `tala:node:stage:dispatch:sweep:ok` expira en 60 s y **sólo** se publica después de la revisión PostgreSQL + reintentos de READY completados.
- Examina como máximo 200 pedidos READY/unassigned; los creados por checkout real con HMAC y marca delivery no deben superar **120 segundos** en espera. Una lista saturada o fecha irregular también es HOLD, no un PASS ficticio.

### Interpretación de resultados

| Marcador | Significado |
| --- | --- |
| `RC89_STANDBY_CHECK=PASS` | El runtime staging está sano, **pero el checkout de domicilio sigue desactivado**; no equivale a autorización comercial |
| `RC89_DISPATCH_STAGING_CHECK=PASS` | Worker de recuperación activo y sin backlog READY vencido durante esa captura de staging |
| `RC89_POSTDEPLOY_READ_ONLY=PASS` | Sólo se hicieron lecturas, sin cambios en PM2, PostgreSQL, Stripe o Redis |
| `RC89_POSTDEPLOY=FAIL_CLOSED` | **HOLD** inmediato: revisar PM2, SHA, API/Cloudflare, worker y backlog. No reintentar pedidos cobrables |
| `RC89_PRODUCTION_GO=NO` | No está aprobado para aceptar dinero real |

En caso de fallo **no reiniciar ni restaurar automáticamente**. Registrar el resultado sin exponer secretos, verificar si hay pedidos existentes que no se deben perder, analizar impacto sobre el esquema y consultar el rollback del promotor RC8 contra la versión anterior intacta. No revertir a una base de datos incompatible ni reembolsar sin registros firmados.

## Prueba operativa después del smoke (manual con datos autorizados)

1. **Usuarios:** abrir sesión, catálogo real, ubicación exacta, quote actual del servidor y una sola confirmación con referencia persistente. El efectivo en domicilio sólo aparece si backend lo declara.
2. **Restaurante:** comprobar que el mismo pedido aparece, aceptar → preparar → listo, sin entrar a otro comercio ni actualizar saldos manualmente.
3. **Repartidor:** usuario verificado, GPS reciente y cerca del restaurante; el backend asigna el READY y la app activa lo refleja con actualización de 5 segundos. Si el driver estaba offline, probar la recuperación del worker. Verificar que datos privados del cliente no se entregan a terceros.
4. **Entrega:** recogido → en camino → PIN → entregado; un solo asiento de efectivo por pedido, sin inventario dos veces ni doble pago, sin mostrar saldos como disponibles para transferir.
5. **Observabilidad:** comprobación después de reiniciar app, devolver del segundo plano, perder Wi-Fi y reintentar sin crear nuevas órdenes. Dejar un canal de atención cuando no existe repartidor.
6. **Firebase:** notificación recibida con app cerrada y permisos correctos: **aún NO validada**. El polling no sustituye FCM.
7. **Pagos:** Stripe pickup TEST/LIVE sujeto a aprobación aparte. Stripe para delivery y reparto/Connect siguen **no implementados para lanzamiento**.

## Motivos de NO-GO público

- No hay prueba real en el Kali desplegado con las tres APKs, ni dueño comercial validado y repartidor reales.
- No hay Stripe delivery TEST/LIVE firmado y conciliado; ni políticas completas de refund/disputa y liquidación efectiva.
- No hay FCM real probado en segundo plano; geodistancia no es kilometraje vial.
- La recaudación de efectivo no es saldo retirable hasta conciliación efectiva.
- Sin una AAB firmada de la cadena aprobada y validación Play Console.

**Evidencia y límites:** verificar en GitHub Actions el SHA final de esta misma rama y exigir **PASS** al workflow `rc89-postdeploy-dispatch-ci.yml`. Todas las pruebas que usen PostgreSQL/Redis de GitHub son sintéticas y no observan el servidor Kali.
