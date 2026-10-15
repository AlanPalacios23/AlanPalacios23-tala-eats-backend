# TALA EATS Backend — lote para runner Windows (15 octubre 2026)

**Estado:** código en rama de preparación; **NO certificado** en Windows, Android, Kali ni con proveedores financieros.

## Alcance de este lote

1. #22 GPS: una muestra Redis se presenta al cliente solamente si ocurrió **después del último evento `assigned`** de ese pedido; sin evidencia de asignación o sin Redis no se publica la ubicación de perfil acumulada en PostgreSQL. Evita exponer la posición previa a una reasignación. La API sigue enviando `driver_location` opcional y las coordenadas legacy del mapa solo para entregas activas autorizadas.
2. #23 FCM: filtra notificaciones de estado reconocibles que quedaron obsoletas, alertas de repartidores reasignados y referencias ajenas al cliente. Notificaciones transaccionales de pagos/seguridad se conservan. Los mensajes legacy sin estado reconocido mantienen el comportamiento existente.
3. Runner: `scripts/qa-backend-windows.ps1` crea un venv y ejecuta scanner local, compileall, smoke Connect, cabeza Alembic y pytest, con SQLite aislado y todos los flags LIVE OFF.

## Ejecución mañana en la PC / runner Windows

Desde la raíz de un checkout **limpio de esta rama**:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\qa-backend-windows.ps1 -InstallDependencies
```

En siguientes ejecuciones, sin reinstalar:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\qa-backend-windows.ps1
```

- Preferir Python **3.13**, que coincide con CI del backend. Si el equipo sigue en 3.12, el script avisa y no se afirma paridad total.
- **Este script NO certifica PostgreSQL/Redis**: requiere un gate aparte sobre contenedores efímeros con Docker Desktop/WSL2; tampoco certifica pagos Stripe TEST ni seguridad Android E2E.
- El runner `tala-eats-windows` había sido vinculado a `tala-eats-mobile`. Un runner **de repositorio** no aparece automáticamente en `AlanPalacios23-tala-eats-backend`. Para usar GitHub Actions en este backend, vincularlo también a este repo o habilitar un runner a nivel de organización; alternativa: ejecutar este script localmente.
- No copiar archivos `.env.production` ni credenciales, no usar accesos a Kali ni Stripe LIVE. No realizar migraciones productivas ni cobros desde estas pruebas.

## Gates para fusionar este lote (mañana)

- [ ] Script Windows PASS con dependencias instaladas en venv aislado.
- [ ] PostgreSQL 16 + Redis 8 + Alembic en Docker efímero PASS.
- [ ] Revisar que Usuarios siga mostrando mapa solo tras un nuevo ping GPS del repartidor asignado; prueba de reasignación, conexión perdida, app en segundo plano y sesión ajena.
- [ ] En Firebase TEST, comprobar notificaciones fuera de orden, expiración, opt-out promocional y roles; **no activar FCM en producción** por este PR.
- [ ] Revisar SHA exacto y código/infraestructura actual en Kali antes de planear release. No fusionar/aplicar cambios a producción sin gates.

Este commit se prepara con `[skip ci]` para ahorrar minutos de GitHub Actions hoy. No debe confundirse con un PASS automático.
