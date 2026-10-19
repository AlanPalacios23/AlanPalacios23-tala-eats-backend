# TALA EATS Node staging — prueba de arranque en frío (sin reiniciar Kali)

**Preparado, no ejecutado en el servidor.** Este runbook da continuidad al hito de arranque persistente de `tala-node-stage` habilitado realmente en Kali el 19-oct-2026. La API pública V3/Python continúa fuera de alcance.

## Estado antes de este runbook

- PostgreSQL nativo 15.19 en `127.0.0.1:15435`, Redis 8 `127.0.0.1:16379` y Node 24/PM2 API+worker en `127.0.0.1:18190` arrancaron manualmente y respondieron PASS reales.
- `loginctl show-user tala-node-stage -p Linger` informó `Linger=yes`.
- `systemctl --user is-enabled` para `tala-node-stage-pg15.service`, `tala-node-stage-redis.service` y `tala-node-stage-pm2.service`: **tres enabled**.
- `pm2 save` ejecutado con dos apps, dump privado; `/ready` con database/redis true y financialWrites false.
- **Pendiente:** confirmar que las unidades tomen la propiedad efectiva de los servicios. Habilitada no equivale a probada.
- **No hacer reboot general de Kali** para esta prueba; el objetivo es simular solo el arranque de las dependencias staging.

## 1. Descargar SHA fijo y respaldar SOLO PostgreSQL staging

En terminal del usuario `tala-node-stage`:

```bash
cd "$HOME/talaeats-node-source"
git fetch origin feat/node24-pm2-native-staging-20261019
git checkout --detach <SHA_VERIFICADO_EN_CI>

python3 node-backend/scripts/kali-stage-backup.py --plan

TALA_STAGE_BACKUP_APPROVAL=I_APPROVE_STAGE_DB_BACKUP_ONLY \
  python3 node-backend/scripts/kali-stage-backup.py --apply
```

El backup usa `pg_dump -Fc`, guarda un archivo **0600** en `~/.local/share/talaeats-node-native/backups/` y verifica `pg_restore --list`. **NO es una restauración completa**: no afirmar recuperación de desastres hasta probar restore aislado. El script nunca toca Docker ni la base 18/main.

Si no aparece `PG15_STAGE_BACKUP_ARCHIVE=PASS` y `PG15_STAGE_ARCHIVE_LIST=PASS`, detenerse.

## 2. Plan de traspaso no mutante

```bash
python3 node-backend/scripts/kali-stage-systemd-cutover.py --plan
```

Exige exactamente dos apps PM2 online de nombres esperados y persistidas en dump, `/ready` verdadero, configuración privada segura, archivo de backup nuevo y legible, tres units `enabled` pero no `active`.

Esperado: `STAGE_CUTOVER_PREFLIGHT=PASS` y `COLDSTART_CUTOVER_PLAN_NO_MUTATIONS=PASS`.

Si los units ya aparecen active, el script ABORTA para evitar repetir un takeover o provocar conflicto de puerto.

## 3. Traspaso controlado EXCLUSIVAMENTE de staging

Ejecutar sólo tras aprobar los dos pasos previos. **Habrá interrupción temporal de la API LOCAL 18190 mientras se detienen/reinician sus tres procesos staging**. No afecta el Caddy público ni Docker V3/GREEN, salvo que alguna dependencia ocultamente use estos recursos (no se ha encontrado evidencia de ello).

```bash
TALA_STAGE_CUTOVER_APPROVAL=I_APPROVE_STAGE_ONLY_SYSTEMD_CUTOVER \
  python3 node-backend/scripts/kali-stage-systemd-cutover.py --apply
```

Secuencia: `pm2 kill` limitado al usuario `tala-node-stage` (con preflight que exige únicamente dos apps), Redis local `shutdown save` autenticado sin contraseña en CLI, PostgreSQL15 local `pg_ctl stop -m fast`, puertos libres, `systemctl --user start tala-node-stage-pm2.service` (automáticamente solo requiere PG15/Redis staging). Después: confirma tres unidades active, `/ready` y ambas apps online.

**Nunca iniciar las unidades si siguen los procesos manuales activos**: habría conflicto de puertos.

Ante fallo, el script intenta detener SOLO esas units y reiniciar los procesos staging manualmente (PG15, Redis, `pm2 resurrect`). Si emite `STAGE_MANUAL_ROLLBACK=FAILED_MANUAL_OPERATOR_REVIEW`, no ejecutar comandos generales, no volver a lanzar `--apply`, y presentar salida sin secretos para diagnóstico.

## 4. Verificación después del traspaso

```bash
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"

systemctl --user is-active \
  tala-node-stage-pg15.service \
  tala-node-stage-redis.service \
  tala-node-stage-pm2.service

pm2 status

curl -fsS http://127.0.0.1:18190/api/v1/health
curl -fsS http://127.0.0.1:18190/api/v1/ready
```

Esperado: tres `active`, dos apps PM2 `online`, health HTTP200 y ready=true, database=true, redis=true, financialWrites=false.

**Sólo después de esta prueba** podremos considerar persistencia de servicios ante reinicio de usuario bajo test. La garantía tras reboot físico sigue sin probarse hasta un reinicio programado del sistema.

## 5. Próximas fases (independientes)

- Probar restauración completa de backup de PostgreSQL stage en un cluster temporal sin acceso a bases productivas; dejar evidencia.
- Diseñar despliegue automático GitHub → Kali para **Node** nuevo, independiente del antiguo agente PM2/Python de PR #79; pin SHA, CI PASS, rollback y sincronización supervisada. No activar autodeploy sin permiso.
- Integrar los contratos de auth, restaurante, menú, pedidos, repartidor y admin; no hacer failover del dominio público al backend Node v0.1.0.
- Stripe SDK y Connect Express en TEST con eventos firmados y ledger; **sin dinero LIVE ni reintentos financieros ciegos**.
