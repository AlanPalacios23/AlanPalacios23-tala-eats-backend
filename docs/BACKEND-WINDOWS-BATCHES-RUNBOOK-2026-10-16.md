# TALA EATS Backend — Ejecutar lotes desde GitHub en runner Windows

**Preparado: 15/oct/2026. Ejecuciones pendientes: 16/oct/2026.** Se creó un único dispatcher **manual** en `main`:
`.github/workflows/backend-batches-windows.yml`.

## Antes de pulsar Run workflow

El runner Windows **`tala-eats-android`** que existe en
`AlanPalacios23/tala-eats-mobile` está configurado para ese repositorio.
No se ha podido comprobar mediante la conexión GitHub si existe un runner online
para `AlanPalacios23/AlanPalacios23-tala-eats-backend`. Un runner registrado
a un repositorio personal no sirve automáticamente a otro.

1. En GitHub, abrir el **backend** privado y entrar a
   **Settings → Actions → Runners → New self-hosted runner**.
2. Elegir **Windows x64**. Registrar una **segunda instancia**, en una carpeta
   distinta de la del runner Flutter, y asignarle la etiqueta
   **`tala-eats-backend`**. Utilizar los comandos y el token efímero
   generados por GitHub; **nunca subir el token al repositorio**.
3. Confirmar que aparece **Idle** y con etiquetas `self-hosted, Windows, X64,
   tala-eats-backend`. Python **3.13** se prepara automaticamente mediante `actions/setup-python@v7` en el runner. No exige cambiar la instalacion del sistema.
4. Si el trabajo permanece en `Queued / Waiting for runner`, primero corregir
   registro, etiquetas, versión/servicio o disponibilidad de la PC; NO gastar
   minutos ejecutándolo en un runner alojado por GitHub.

## Lanzar las pruebas desde el celular o PC

1. Abrir
   https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/workflows/backend-batches-windows.yml
2. Pulsar **Run workflow** → rama **`main`**.
3. Elegir `gps-fcm`, `readiness`, `finanzas` o `todos`.
4. `suite_completa=true` ejecuta la suite pytest completa en GPS y finanzas.
5. `consultar_ready_publico=false` evita tráfico al servidor. Activar `true`
   solo para hacer un **GET de diagnóstico** de `/api/v1/ready` en el lote
   `readiness`, después de revisar las implicaciones del acceso externo.

El workflow se activa **solo** con `workflow_dispatch`, desde `main`,
por la cuenta dueña `AlanPalacios23`, con permisos `contents:read`.
Los lotes usan SHAs **inmutables y predeterminados**, no ramas de PR arbitrarias.
El runner trabaja con `persist-credentials:false`, variables de pago
y retiros deshabilitadas, SQLite efímero y sin GitHub-hosted Actions.

| Lote | PR | SHA fijo | Cobertura de mañana |
|------|----|----------|---------------------|
| `gps-fcm` | #40 | `929cec9acc10f6206ed41920e4954b9e0b8a4171` | Security preflight, smoke Connect, Alembic heads, pytest |
| `readiness` | #41 | `a3b816b909d6649ac6e4bf24985488f9dde037c2` | Diagnóstico HTTP synthetic, unittest. GET público opt-in |
| `finanzas` | #42 | `f3c8734e9b8564302eb4197fbd880b087fb88e74` | Test GO/NO-GO, suite opcional, salida bloqueante **2** |

**Nota:** PR #41 depende de #20; PR #42 depende de #29. No debe hacerse
merge de esas PR encima de `main` sin resolver su base, revisar seguridad,
concurrencia, regresiones de flujo y confirmar los gates faltantes.

## Correcciones de mañana

Al encontrar un fallo, tomar el log y corregir el código en su **PR original**
en vez de editar producción. Si cambia el SHA de ese lote, hay que actualizar
el checkout fijo de este dispatcher mediante revisión; nunca cambiar a
`ref: ${{ github.event.pull_request.head.sha }}` para un runner personal.

Este dispatcher **no ejecuta** PostgreSQL16/Redis8 en Docker, ni Stripe TEST
externo, ni E2E Android ni firma de APK. Se harán en gates separados después
de que estas primeras pruebas pasen. No activa dinero, migraciones de producción,
monitor continuo o despliegues Kali.

## Evidencia de ejecucion Windows (15/oct/2026)

- [Run #1](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38770193378): FAIL preflight: Python 3.13 no disponible en PATH. Arreglado en workflow con setup-python@v7.
- [Run #2](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38770923701): Python 3.13.16 PASS; FAIL parser PowerShell 5.1 por mensajes no ASCII en QA. Arreglado en PR #40 commit `929cec9acc10f6206ed41920e4954b9e0b8a4171`.
- [Run #3](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/actions/runs/38771425138): reejecucion con codigo corregido. Su resultado final debe consultarse en GitHub; no se presume PASS.
- Los disparadores temporales se retiraron y el workflow en `main` vuelve a ser **manual-only**, con commits fijados y pagos LIVE bloqueados.
