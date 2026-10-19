# TALA EATS — arranque persistente de staging nativo en Kali

**Estado:** preparado en PR #80, **sin activar todavía en Kali**. No ejecutar reboot hasta validar la configuración.

## Evidencia inicial

El operador confirmó en Kali Node 24.22.0, PM2 6.0.14, PostgreSQL nativo 15.19 (15435), Redis nativo 8 (16379), API y worker PM2 online sin reinicios, HTTP 200 a `/health`, `/ready` con `ready:true` y `financialWrites:false`; seis pruebas locales PASS. Los procesos PostgreSQL/Redis fueron creados de forma independiente y actualmente no tienen supervisor persistente tras reinicio.

## Estrategia y límites

Tres archivos **systemd de usuario** bajo `~/.config/systemd/user`, NO en `/etc/systemd/system`:

1. `tala-node-stage-pg15.service`: usa exclusivamente los binarios PG15 compilados en HOME de staging y su PGDATA aislado, no el cluster PG18 5432.
2. `tala-node-stage-redis.service`: usa solo `redis-stage.conf`, anula `daemonize yes` para que systemd supervise el proceso en foreground.
3. `tala-node-stage-pm2.service`: depende de los dos servicios nativos y verifica ambos puertos antes de `pm2 resurrect`; después exige `/ready` con `financialWrites:false` y ambos procesos PM2 online.

Con `loginctl enable-linger tala-node-stage` el user manager se iniciará después de un arranque de Kali incluso sin sesión del usuario staging. **Esta es una modificación administrativa del sistema que requiere ejecución consciente del operador.** Evitar `pm2 startup` y los servicios Python de PR #79.

### 1. Preflight completamente no mutante como `tala-node-stage`

```bash
cd "$HOME/talaeats-node-source"
git fetch origin feat/node24-pm2-native-staging-20261019
# Sustituir por el SHA validado de la PR #80.
git checkout --detach <SHA_VERIFICADO>
python3 node-backend/scripts/kali-stage-boot-persistence.py --plan
```

Debe reportar `STAGE_API_READY=PASS`, `UNITS_STAGE_ONLY=PASS`, `NO_MUTATIONS_PLAN=PASS`. `LINGER=not_enabled` es esperable antes de activarlo. El plan **no ejecuta PM2 save ni systemctl enable**.

### 2. Activar user lingering como administrador (`alan`)

Salir de la shell `tala-node-stage` para volver al usuario `alan`; verificar propietario, luego:

```bash
id tala-node-stage
loginctl show-user tala-node-stage -p Linger
sudo loginctl enable-linger tala-node-stage
loginctl show-user tala-node-stage -p Linger
```

Aprobar explícitamente `enable-linger` solo para `tala-node-stage`, no otros usuarios. No inicia ni reinicia los servicios actuales, pero mantiene activo el user manager aun sin sesión. Si el sistema no usa systemd/logind, no aplicar este enfoque y detenerse.

### 3. Guardar PM2 y habilitar unidades `--enable` SIN `--now`

Volver a la cuenta `tala-node-stage` con `sudo -iu tala-node-stage`. Ejecutar:

```bash
cd "$HOME/talaeats-node-source"
TALA_STAGE_BOOT_APPROVAL=I_APPROVE_ENABLE_STAGE_USER_UNITS_ONLY \
  python3 node-backend/scripts/kali-stage-boot-persistence.py --apply
```

`--apply` exige exactamente dos aplicaciones PM2 online, guarda su lista mediante `pm2 save --force` (dump privado 0600), instala solo tres units en `~/.config/systemd/user`, hace `systemctl --user daemon-reload` y `systemctl --user enable` **SIN arrancar, detener o reiniciar servicios**.

### 4. Verificaciones sin cambio de procesos actuales

```bash
systemctl --user list-unit-files 'tala-node-stage-*.service'
systemctl --user is-enabled \
  tala-node-stage-pg15.service \
  tala-node-stage-redis.service \
  tala-node-stage-pm2.service
pm2 status
curl -fsS http://127.0.0.1:18190/api/v1/ready
```

Las unidades estarán **enabled pero aún inactive**; los servicios de staging de esta sesión seguirán funcionando como procesos iniciados manualmente. Esa es la situación prevista hasta una prueba controlada de traspaso/reinicio.

**NO reiniciar Kali ni forzar una toma de control de las unidades aún**. Para validar un arranque limpio sin interrupción de producción, preparar respaldo del pequeño PostgreSQL staging, verificar recuperación, comprobar recursos y ventana de mantenimiento; entonces detener únicamente PM2/PG/Redis staging y arrancarlos con `systemctl --user start tala-node-stage-pm2.service`, inspeccionar estado y revertir si hay fallo. No habilitar DNS, cambios a Caddy/Cloudflare ni Stripe LIVE.

### Recuperación manual de staging

Si tras un reinicio las unidades no arrancan, operar únicamente bajo usuario `tala-node-stage`. Ver sin imprimir secretos:

```bash
systemctl --user --no-pager status tala-node-stage-pg15.service
systemctl --user --no-pager status tala-node-stage-redis.service
systemctl --user --no-pager status tala-node-stage-pm2.service
```

No mostrar ficheros de `.config` ni logs financieros públicamente. La recuperación productiva V3 sigue separada y no se resuelve con estas unidades.

## Checklist NO-GO

- No cambiar Docker/PG18/Redis productivo, backend V3/Green, admin, DNS, Caddy, Stripe LIVE, bancos ni retiros.
- No fusionar PR #80 sin CI verde y revisión.
- No fusionar PR #79 como agente Node.
- No crear timers de autodeploy sin firmar SHA/CI y rollback.
- No afirmar persistencia tras reboot hasta ejecutarlo y comprobarlo.
