# Tala Eats — traspaso operativo Kali RC12.8 / tres PWA / Stripe TEST
**Evidencia recogida:** 29 de octubre de 2026 (sesión de operador, zona America/Mexico_City).  
**Propósito:** retomar el trabajo en otro chat/equipo sin volver a mezclar LIVE, STAGING, GitHub, PWA ni controles financieros.  
**Alcance:** bitácora de observaciones suministradas por el operador, contrastadas donde se indica con código del repositorio. **NO** constituye una autorización comercial ni un informe de pruebas de pagos completadas.

> **LEER PRIMERO.** El objetivo fijado por el operador al cerrar esta sesión es **terminar la funcionalidad de las aplicaciones LIVE** (Clientes → Restaurante → Repartidor → PIN → Wallet) y usar Stripe TEST solo para las pruebas financieras imprescindibles. No volver a convertir la PWA estática STAGING ni su registro de repartidores en una tarea prioritaria. **No** saltarse gates financieros LIVE por ahorrar tiempo. No reutilizar datos, clientes, conductores o cuentas Connect de producción como fixtures de TEST.

## 1. Fuente de verdad y advertencias sobre versiones

| Elemento | Evidencia comprobada el 29/oct | No inferir |
|---|---|---|
| Backend LIVE Node API + worker | Dos PM2 `tala-node-stage-api` y `tala-node-stage-worker` **ONLINE** desde el mismo checkout `1562827129b90094bce90cca3647c57d94e33fcc` (RC12.8). `/api/v1/ready` local/público: PASS. | Que todos los modos de checkout, entrega y retiro estén liberados. |
| Código RC12.8 | Rama `fix/rc128-connect-test-webhook-reconciliation-20261029`, SHA inmóvil anterior. | Que `main`, una etiqueta RC8.13 o el script antiguo RC9.5 representen lo desplegado. |
| STAGING paralelo | API+worker local `127.0.0.1:18192`, `environment=staging`, `ready=true`, `financialWrites=false`; PostgreSQL 15.19 separado. | Que el SHA compilado del proceso paralelo ya haya sido cotejado con RC12.8: **NO SE COTEJÓ**. |
| PWA LIVE | Clientes, Restaurantes, Repartidores usan backend LIVE `18190`. | Que un hostname con “stage” sea STAGING. |
| PWA STAGING | Tres sitios Nginx locales creados y comprobados el 29/oct (HTTP/HTML/API PASS). | Que se haya completado login, onboarding, compra, PIN, wallet o Stripe TEST. |
| Driver LIVE | 1 perfil, 1 verificado, 1 marcado online, 1 con GPS fresco Redis. | Que despacho, aceptación/entrega o retiros estén activos. |

No declarar una operación `PASS` si solo se ha verificado carga de página, compilación, bandera, ruta HTTP o firma HMAC artificial. Los archivos de documentación RC8.13 previos describen un estado **histórico**, no necesariamente el runtime actual. Volver a identificar el proceso activo ANTES de ejecutar un procedimiento versionado.

## 2. Topología real: puertos y fronteras

### Servicios LIVE (todos respondieron HTTP 200 al terminar las instalaciones de ensayo)

| Servicio | Puerto loopback | Destino / detalle |
|---|---:|---|
| Backend LIVE Node | `18190` | PM2 API y worker con usuario Unix `tala-node-stage` |
| Clientes LIVE | `18195` | Nginx propio: `/etc/talaeats-web-pwa/nginx.conf`, `/etc/talaeats-web-pwa/server.conf`, root `/srv/talaeats-pwa/current` |
| Vista previa web (NO STAGING) | `18196` | Nginx `/etc/talaeats-web-preview/nginx.conf`, API LIVE |
| Restaurantes LIVE | `18197` | Nginx `/etc/talaeats-restaurantes-pwa/nginx.conf`, root `/srv/talaeats-restaurantes-pwa/current` |
| Repartidores LIVE | `18199` | Nginx `/etc/talaeats-repartidores-pwa/nginx.conf`, root `/srv/talaeats-repartidores-pwa/current` |
| Otros | `18191` | Cloudflared usa este origen para rutas legales del dominio principal, según YAML leído |

Las tres configuraciones Nginx de las PWA **LIVE** tienen `location ^~ /api/v1/` con `proxy_pass http://127.0.0.1:18190;`. El servicio PWA de clientes y los otros servicios usan instancias Nginx **independientes**, por lo que ejecutar únicamente `nginx -T` sin `-c` inspecciona otro daemon y puede devolver resultados engañosos.

### STAGING aislado existente

| Servicio | Puerto | Frontera |
|---|---:|---|
| API Node paralelo | `18192` | PM2 independiente (`~/.pm2-tala-rc813-parallel`); env privado `~/.config/talaeats-node-rc813-parallel.env`, Node `NODE_ENV=staging` |
| PostgreSQL staging | `15435` | `tala_node_stage`, PostgreSQL **15.19**, sin acceso a PG LIVE |
| Redis staging | `16379` | Instancia separada; el RC8.13 paralelo usa DB `/1`; no reutilizar claves LIVE |
| Cliente STAGING PWA | `18205` | Nginx `/etc/talaeats-stage-pwa/nginx.conf`, proxy API `18192` |
| Restaurante STAGING PWA | `18207` | Mismo servicio aislado, proxy API `18192` |
| Repartidor STAGING PWA | `18209` | Mismo servicio aislado, proxy API `18192` |
| Listener Connect Stripe TEST | `18193` | Proceso explícito/temporal fuera de API LIVE, cuando se ejecuta; **no asumir que sigue escuchando** |

Las tres PWA de ensayo comparten el servicio `talaeats-stage-pwa.service`. Se montaron desde **copias lógicas fijadas de los roots estáticos públicos existentes**, no desde una nueva compilación TEST específica. Enrutamiento local y HTML PASS, **no equivalencia funcional validada**. Están vinculadas exclusivamente a `127.0.0.1` y no se publicaron en Cloudflare.

**Cloudflare:** YAML local mostraba `web-talaeats.alan-palacios-dev.com` → `18195` y `api-stage-talaeats.alan-palacios-dev.com` → **18190 LIVE**, NO `18192`. Una llamada a `https://api-stage-talaeats.alan-palacios-dev.com/api/v1/health` respondió `production=true`. Nunca usar ese dominio para una prueba Stripe TEST ni “corregirlo” a ciegas alterando el dominio API público. El dominio principal tiene entradas de ruteo para `18190` y `18191`; respetar reglas por ruta existentes.

**Acceso desde Windows** usado con el túnel SSH (no abrir puertos públicamente): 
`ssh -N -o ExitOnForwardFailure=yes -L 18205:127.0.0.1:18205 -L 18207:127.0.0.1:18207 -L 18209:127.0.0.1:18209 alan@<KALI_LAN_IP>`. El modo `-N` mantiene la ventana sin mostrar una aplicación; las páginas se abrieron en el navegador de Windows y cargaron. Usar perfiles de navegador diferentes (cookies de `localhost` compartidas entre puertos) y **no usar cuentas LIVE**.

## 3. Validaciones observadas en LIVE

29/oct, diagnóstico actual (no usar `rc95-activar-driver.sh --verify` como prueba de versión actual):

`RC128_PM2_API=ONLINE`; `RC128_PM2_WORKER=ONLINE`; ambas rutas del proceso apuntan al SHA `1562827129b90094bce90cca3647c57d94e33fcc`; `RC128_PM2_IDENTITY=PASS`; `RC128_READY_LOCAL=PASS`; `RC128_READY_PUBLIC=PASS`; endpoint de readiness del conductor anónimo devuelve 401/403 (`RC128_DRIVER_AUTH_GATE=BLOCKED_PASS`).

Conteos en PG LIVE: `DRIVER_LIVE_DRIVER_USERS=1`; `DRIVER_LIVE_DRIVER_PROFILES=1`; `DRIVER_LIVE_VERIFIED=1`; `DRIVER_LIVE_ONLINE=1`. Comparación Redis/DB adicional: `DRIVER_VERIFIED_ACTIVE=1`, `DRIVER_ONLINE=1`, `DRIVER_FRESH_GPS=1`, `DRIVER_DISPATCH_PRESENCE=READY`. No se difundieron coordenadas. **Presencia lista no equivale a despacho liberado**.

**Flags LIVE efectivas observadas:**

- `LIVE_DRIVER_PRESENCE_ENABLED=true`.
- `LIVE_DELIVERY_DISPATCH_ENABLED=false`.
- `LIVE_DELIVERY_CARD_CHECKOUT_ENABLED=false`.
- `LIVE_DELIVERY_RELEASE_APPROVED=false` y `LIVE_DELIVERY_CARD_E2E_APPROVED=false`.
- `LIVE_DELIVERY_CASH_CHECKOUT_ENABLED=false`, `LIVE_DELIVERY_CASH_DISPATCH_ENABLED=false`, `LIVE_DELIVERY_CASH_RELEASE_APPROVED=false`.
- `STRIPE_CONNECT_TRANSFERS_ENABLED=false`.
- `TREASURY_CONNECT_WEBHOOK_INGEST_ENABLED` fue `UNDEFINED` al leer la variable *cruda* del archivo LIVE; `src/config.ts` la define con predeterminado `false`. No interpretarlo como webhook Connect LIVE activado.

**Fallo histórico RC9.5 explicado:** `rc95-activar-driver.sh --verify` devolvió `RC95_PM2_IDENTITY=FAIL` porque el script `scripts/rc95-driver-presence-live-cutover.sh` fija un directorio SHA RC9.5 y comprueba exactamente ese CWD/entrypoint; el backend LIVE ya ejecutaba RC12.8. El chequeo actualizado sobre `pm2 jlist` y rutas reales pasó. **No** ejecutar `--apply` ni `--rollback` del cutover RC9.5 sobre RC12.8.

## 4. STAGING: pruebas, datos y finanzas RC12.8

**Migraciones STAGING aplicadas** el 29/oct tras respaldo `pg_dump` del stage (sin tocar LIVE):
- `20261028_rc93_connect_otp_replay_hardening`
- `20261028_rc97_driver_plate_registration`
- `20261028_treasury_v1_restaurant_driver`

Salida: `RC128_MIGRATIONS=3_OF_3_PASS`; `RC128_TREASURY_TABLES=6_OF_6_PASS`; `RC128_CONNECT_OTP=PASS`; `RC128_DRIVER_PLATE=PASS`; `RC128_STAGE_SCHEMA=PASS`; `RC128_STRIPE_OPERATIONS=NONE`. El respaldo privado se registró en `~/.config/rc128-stage-backups/`. **`RC128_RESTORE_TEST=NOT_PERFORMED`:** no decir que la restauración fue ensayada. Las seis tablas comprobadas incluyen `tala_live_treasury_transfers`, `tala_live_treasury_withdrawals`, `tala_live_treasury_events`, `tala_live_treasury_ledger`, `tala_live_treasury_admin_steps` y `tala_live_treasury_totp_attempts`. Prefijo `tala_live_*` es el nombre del modelo, **no** autoriza apuntar a PG LIVE.

**Prueba de receptor Stripe TEST RC12.8:**
- Stripe CLI `stripe listen --events-from @accounts --events payout.created,payout.updated,payout.paid,payout.failed,payout.canceled --forward-connect-to http://127.0.0.1:18193/api/v1/webhooks/stripe-connect`, con listener privado TEST `scripts/rc128-stripe-test-connect-webhook-listener.mjs --listen-test I_APPROVE_STRIPE_TEST_SIGNED_RECONCILIATION_ONLY` bajo `tala-node-stage` y archivo stage 0600.
- Se observaron `RC128_UNSIGNED_WEBHOOK=BLOCKED_PASS` y `RC128_SIGNED_LOCAL_PROBE=PASS_NO_FINANCIAL_WRITE`; esto fue **firma local HMAC**, **NO** un payout real recibido desde Stripe.
- `RC128_CONNECT_TEST_READ=PASS`, `RC128_CONNECT_TEST_ACCOUNTS=0`, `RC128_CONNECT_PAGINATION=COMPLETE`, `RC128_TREASURY_INBOX_READ=PASS` y `RC128_STAGE_DB=PASS`; todas las filas consultadas de mappings/transferencias/retiros/eventos eran 0. `RC128_LIVE_PAYMENTS_EXECUTED=NO`. No se ensayó transferencia, depósito bancario ni retiro TEST real.
- Mantener explícitamente desactivadas las seis banderas financieras LIVE en el entorno TEST: `STRIPE_FINANCIAL_WRITES_ENABLED`, `STRIPE_LIVE_ENABLED`, `STRIPE_LIVE_RELEASE_APPROVED`, `STRIPE_CONNECT_TRANSFERS_ENABLED`, `STRIPE_MANUAL_SETTLEMENT_APPROVED`, `STRIPE_REFUNDS_ENABLED`. Nunca compartir `sk_*`, `whsec_*`, JWT, conexión DB o códigos OTP en logs o GitHub.

**Datos comerciales observados en la base staging 15435:**
- `RC128_STAGE_USERS=4`: ADMIN 1, CUSTOMER 2, RESTAURANT 1; DRIVERS 0.
- RESTAURANTS 1 y `STAGE_OPEN_STORES=1`; 1 producto disponible (`STAGE_PRODUCTS=1`).
- `STAGE_DRIVER_PROFILES=0`, `STAGE_ORDERS=0`, `STAGE_DELIVERY_PROOFS=0`, `STAGE_PAYEE_ALLOCATIONS=0`.
- 0 mappings Connect de comercio y driver; 0 solicitudes de alta driver pendientes.
- `AUTH_V02_ENABLED=true`, `MARKETPLACE_B_ENABLED=true`; en el archivo stage revisado previamente, `STAGE_PICKUP_CASH_CHECKOUT_ENABLED=false`, `STAGE_STRIPE_TEST_CHECKOUT_ENABLED=false`, `STAGE_DRIVER_DELIVERY_ENABLED=false`, `STAGE_DELIVERY_CASH_CHECKOUT_ENABLED=false`, `STAGE_DELIVERY_STRIPE_TEST_ENABLED=false`.
- **Atención**: hay varios archivos env STAGING; el chequeo de esas cinco banderas se efectuó sobre un stage env privado seleccionado por nombre, **no equivale a certificar todos los flags del paralelo**. En el archivo explícito `talaeats-node-rc813-parallel.env` sí se comprobó `NODE_ENV=staging`, `PORT=18192`, `STAGE_PARALLEL_ENABLED=true`, `AUTH_V02_ENABLED=true`, `MARKETPLACE_B_ENABLED=true` y `STAGE_DRIVER_DELIVERY_ENABLED=false`.

**Posible brecha técnica a revisar antes de retiros:** al revisar código fuente RC12.8 se observó que algunas reservas/validaciones de tesorería exigen comprobantes `stripe_live_payment`/`stripe_live_collected`, mientras que las pruebas Stripe TEST pueden emitir comprobantes `stripe_test_payment`/`stripe_test_collected`. Es una **sospecha de incompatibilidad no reproducida E2E**, no un fallo confirmado en ejecución. Corregir con pruebas sobre etapa aislada, sin inventar ledger, saldos o cuentas Connect. Consultar `docs/rc128-stripe-test-treasury-rehearsal.md`.

## 5. Instalación de las tres PWA STAGING y lecciones

Se crearon archivos aislados en `/etc/talaeats-stage-pwa/` y un servicio **nuevo** `talaeats-stage-pwa.service`, conservando todos los roots de frontend LIVE y sustituyendo solo puertos, server_name, root resuelto y proxy `18190 → 18192` en tres bloques Nginx dedicados.

**Incidentes resueltos sin tocar LIVE:**
1. Primera instalación: `systemctl` reportó “Started”, pero el proceso falló al abrir `/run/talaeats-stage-pwa/nginx.pid` con `Permission denied`. El rollback borró su configuración/servicio. No asumir `systemctl enable --now` equivale a HTTP ready.
2. Segundo intento: `nginx -t` se ejecutó fuera de systemd, antes de crear `/run/talaeats-stage-pwa`, y devolvió `No such file or directory`; rollback nuevamente. No precrear runtime PID como root.
3. Solución: `RuntimeDirectory=talaeats-stage-pwa`, `RuntimeDirectoryMode=0700`, `User=www-data`, `Group=www-data`, `ExecStartPre=/usr/sbin/nginx -t -c /etc/talaeats-stage-pwa/nginx.conf` dentro de systemd, más espera de HTTP real en los tres puertos y rollback acotado. Finalmente `STAGE_NGINX_READY=PASS`, `STAGE_CLIENTES_WEB/API=PASS`, `STAGE_RESTAURANTES_WEB/API=PASS`, `STAGE_REPARTIDORES_WEB/API=PASS`, `STAGE_THREE_PWA=PASS`, `TALA_STAGE_INSTALL=PASS` y todos los cinco servicios previos respondieron HTTP 200.

**No reutilizar los scripts de instalación inicial como mecanismo de actualización**; los scripts de esa sesión no se versionaron en GitHub. El servicio ya está creado en Kali. Antes de cambiar configuración, recuperar la configuración vigente, inspeccionar systemd y preparar backup+rollback específico. No pisar `/etc/talaeats-stage-pwa/` mediante un instalador “primera vez”.

## 6. Por qué el formulario de registro Repartidores STAGING permanece deshabilitado

En la PWA Repartidores STAGING `http://127.0.0.1:18209/repartidor/registro`, la captura mostró “**Verificando disponibilidad del registro** / Estamos preparando el registro de repartidores con placas. No crearemos cuentas incompletas”, con `input` deshabilitados.

En el frontend `tala-eats-version-web` ref `7337c5305cbc839e0a3e180d43e0f4a6e1142493`, archivo `src/components/DriverRegistration.tsx`: `DriverRegistration` espera `api.driverOnboardingCapabilities()`; si falla con HTTP 404 muestra ese texto y mantiene `cap=null`, por lo tanto `disabled={busy||!cap}`. La UI bloquea a propósito un alta que no puede validar placas; no es un problema de teclado ni DevTools. `src/lib/api.ts` llama a `/api/v1/operations/onboarding-capabilities`.

**Confirmación por HTTP del operador (29/oct):**
- `GET http://127.0.0.1:18192/api/v1/operations/onboarding-capabilities` → **404** `{"error":"not_implemented"}`.
- El mismo endpoint vía `18209` → **404** igual.
- Archivo env **paralelo**: `AUTH_V02_ENABLED=true`, `MARKETPLACE_B_ENABLED=true`, `NODE_ENV=staging`, `PORT=18192`, PostgreSQL stage correcto.

El código fuente RC12.8 `node-backend/src/operational/routes.ts` **sí** declara `operationsRouter.get('/onboarding-capabilities',...)`, y `src/app.ts` monta `operationsRouter` bajo `/api/v1/operations` cuando MARKETPLACE está activo. **No se llegó a cotejar el SHA y los archivos `dist` del proceso 18192**, por lo que **no afirmar todavía** que la única causa sea compilación vieja: verificar runtime `cwd`, SHA, `dist/app.js` y `dist/operational/routes.js` antes de actualizar exclusivamente PM2 STAGING. No manipular verificaciones, perfiles ni placas directamente en DB.

**Decisión del operador:** se detuvo esta línea de depuración para **priorizar trabajo funcional en las tres PWA LIVE**. No reabrir el registro estático STAGING por rutina; retomarlo solo si impide una prueba imprescindible y entonces tratar el 404 según la evidencia anterior.

## 7. Prioridad del siguiente trabajo y criterios de aceptación

**Objetivo principal, en este orden:**
1. Revisar **versiones actuales** de los tres repos/frontends y el backend LIVE; las tres PWA existentes ya están publicadas. Trabajar sobre los flujos LIVE reales y no reconstruir interfaces por duplicado. Separar cambios de UI/código (desplegables con rollback) de liberaciones financieras.
2. Cliente selecciona producto real, obtiene cotización server-side, stock y tarifa, confirma idempotentemente; respetar si el método está bloqueado. Para tarjeta no marcar `paid` antes de webhook firmado y ledger.
3. Restaurante recibe solo pedido autorizado, acepta → `confirmed` → `preparing` → `ready`, con estado persistente, outbox y actualizaciones desde su PWA.
4. Driver existente LIVE **ya** verificado/online/GPS fresco; comprobar identidad autenticada, exclusividad de asignación, radio, actualización GPS, PIN, reintentos y no entrega duplicada. **LIVE checkout/dispatch de domicilio permanecen OFF**, por lo que no se puede declarar una entrega operativa comercial.
5. Garantizar cierre de pedidos, Wallet/ledger de restaurante y driver con comisión, tarifa, propinas y deuda de efectivo correctas. **Efectivo cobrado físicamente no es saldo Stripe bancario disponible**. “Retirar ganancias” no debe estar activo si no hay balance transferible, doble aprobación/MFA, executor idempotente y conciliación.
6. Usar Stripe TEST **solo** para E2E indispensable: PaymentIntent, webhook externo real firmado, entrega con PIN, split correcto, Connect TEST de ambos beneficiarios, transfer/payout/reconciliación e incidentes (reembolsos/disputas/replays). La prueba local HMAC no sustituye nada de esto. Solo luego preparar piloto LIVE con aprobación separada, evidencias/rollback, sin desbloquear `STRIPE_CONNECT_TRANSFERS_ENABLED` anticipadamente.

**Estado GO/NO-GO al cierre:** infraestructura/API y presencia driver = PASS; staging PWA HTTP = PASS; formulario driver staging = **BLOCKED (404)**; pedido E2E 3 PWA = **NO PROBADO**; Stripe TEST remoto payout = **NO PROBADO**; domicilio LIVE efectivo/tarjeta = **OFF**; retiros bancarios LIVE = **OFF**. Por tanto **NO-GO** para anunciar entrega a domicilio y retiros completamente operativos.

Revisar también:
- `docs/RC112-RC117-LIVE-COMMERCIAL-ACCEPTANCE.md` — puertas de aceptación LIVE.
- `docs/rc123-operational-four-mode-pilot.md` — cuatro modos independientes de checkout.
- `docs/rc126-pre-onboarding-acceptance.md` — alta real por ADMIN y pruebas.
- `docs/rc128-stripe-test-treasury-rehearsal.md` — Stripe TEST y webhook firmado.
- `docs/RC813-KALI-PARALLEL-STAGING-20261024.md` — origen histórico del entorno paralelo; no reutilizar plan de instalación como si no existiera.

## 8. Reanudación segura: SOLO lectura primero

Desde Kali, comprobar sin alterar dinero, cuentas ni servicios:

```bash
# Identidad y salud: distinguir LOCAL LIVE de STAGE
curl -fsS --max-time 8 http://127.0.0.1:18190/api/v1/ready
curl -fsS --max-time 8 http://127.0.0.1:18192/api/v1/ready

# Estado real de los sitios PWA
for p in 18195 18197 18199 18205 18207 18209; do
  curl -sS -o /dev/null -w "$p %{http_code}\n" --max-time 6 \
    "http://127.0.0.1:$p/api/v1/health"
done

# Instancias propias; nginx -T por defecto NO muestra estos archivos
systemctl status talaeats-web-pwa.service \
  talaeats-restaurantes-pwa.service \
  talaeats-repartidores-pwa.service \
  talaeats-stage-pwa.service --no-pager

# Si de veras se retoma el registro STAGING:
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 8 \
  http://127.0.0.1:18192/api/v1/operations/onboarding-capabilities
```

Nunca imprimir archivos `.env` completos, nombres/correos de clientes, PIN de entregas, claves Stripe, tokens o coordenadas GPS. Antes de cualquier escritura: confirmar el usuario Unix, `NODE_ENV`, puerto, DB/Redis reales, SHA runtime, revisión CI, backup/restore y aprobación separada. Los comandos que devuelven HTTP 200 **no** autorizan cambios de banderas de producción.

**Fin del handoff.** Nuevas pruebas posteriores pueden cambiar estos hechos; añadir una nota con fecha/evidencias en lugar de sobrescribir resultados históricos como si nunca hubieran existido.
