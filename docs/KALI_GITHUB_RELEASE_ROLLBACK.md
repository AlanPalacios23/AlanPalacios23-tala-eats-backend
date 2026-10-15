# TALA EATS — GitHub → Kali: despliegue controlado y rollback

**Estado:** diseño/preflight; **NO EXISTE TODAVÍA UN DEPLOY AUTOMÁTICO NI ROLLBACK HABILITADO**. No ejecutar operaciones productivas basándose sólo en este documento.

## Evidencias previas (15-oct-2026)
- Verificador en Kali ejecutado por el operador: `GITHUB_KALI_SOURCE_AND_READY_PASS`, 71 archivos de runtime cotejados sin diferencias contra commit `e22e4d5626c153d325b8f80278569b3534ecd652`.
- Contenedor `talaeats-v3-backend-1`: `running`, `healthy`.
- Alembic activo: `f21i00000001 (head)`, igual a `alembic heads`.
- PR #30 fusionada en `710e97f8ecd1b8a65f7bffd2f5fa00c6eaa2836e`. Sólo añadió workflow y test financieros, **sin cambiar código runtime**, PostgreSQL ni Stripe.
- Tres workflows sobre main/commit 710e97…: QA, PostgreSQL/Redis y finanzas completados success.
- Esta atestación **no** certifica por sí sola copias de seguridad, configuración Compose, datos, secret keys, reservas financieras ni el procedimiento de rollback.

## Principios de operación
1. **Fuente de verdad:** repo privado GitHub, cambios por PR con pruebas y revisión. Nunca escribir código dentro del contenedor LIVE.
2. **Distribución:** **pull desde Kali** mediante GitHub CLI ya autenticado; no necesita abrir SSH de producción a runners públicos ni almacenar claves LIVE en GitHub. Cualquier despliegue se dispara **manualmente** con confirmación explícita y SHA fijo revisado.
3. **Conservar el stack existente:** cambiar sólo servicios API y worker relacionados cuando se conozcan sus nombres Compose. No tocar Caddy, Cloudflared, Redis, PostgreSQL, ADMIN, fotos ni CODEXIA salvo petición explícita.
4. **Imagen inmutable:** construir candidata con nombre/tag asociado a SHA y preservar antes la imagen exacta que ejecuta producción, mediante etiqueta local de rollback.
5. **Respaldo real:** PostgreSQL consistente, volumen de fotos, configuración operacional y referencias de imágenes; cifrados, con copia fuera del mismo host y prueba de restauración. No almacenar datos/secretos en GitHub.
6. **Migraciones:** entrypoint actual invoca `alembic upgrade head`. Validar migraciones **sobre copia de PostgreSQL**, desde el head real y contra el commit candidato, antes de recrear contenedores. Las migraciones de producción no se revierten automáticamente.
7. **Seguridad financiera:** Stripe LIVE queda intocable por la fase CI. Payouts, cambios de claves, webhooks, saldos, reembolsos o migraciones financieras destructivas requieren aprobación y reconciliación específica.
8. **Health + supervisión:** después de promover versión, verificar `ready=true`, versión exacta, worker, conectividad DB/Redis, autenticación, regresiones y errores. Tener ventana de mantenimiento y observabilidad.
9. **Rollback de código:** sólo a imagen anterior, coordinando API+worker, si el esquema sigue siendo compatible. Si no es compatible, detener despliegue y decidir reparación forward/recuperación supervisada de DB. **No hacer downgrade automático de Alembic ni restaurar una DB LIVE con pagos posteriores al backup**: podrían perderse asientos o repetirse pagos.
10. **No CD automático desde push:** fusionar un PR puede publicar una candidata, pero nunca debe reiniciar Kali. Habilitar despliegue únicamente tras autorización manual y gates completos.

## Fase A (implementada en este PR): descubrimiento SIN cambios
Desde un checkout validado de este repositorio **en Kali**:

```bash
bash scripts/kali_release_inventory_readonly.sh
```

La salida incluye nombres de servicios, proyecto y rutas Compose (no claves ni contenidos). Revisar antes de compartir. El inventario NO consulta `.env`, credenciales Stripe, volúmenes de datos ni `docker inspect` completo. Si algo no concuerda con el proyecto esperado, aborta.

**No pasar a Fase B antes de revisar la salida y los resultados QA.**

## Fase B (pendiente): scripts de deploy y rollback con topología real
Construir `deploy-kali.sh` y `rollback-kali.sh` sólo después de obtener:
- ruta y lista reales de ficheros Compose, nombres exactos de servicios API/worker y proyectos Docker
- estrategia de imágenes, volúmenes, red, proxy, permisos/ownership y lugar de releases
- identificación segura del contenedor PostgreSQL y ruta de respaldo/restore validada
- verificación de tags/sha, salud del worker, compatibilidad de migraciones e inventario de operaciones de Stripe potencialmente pendientes

**Pruebas obligatorias**: ejecutar deploy/rollback en laboratorio con Compose y PostgreSQL desechables o copia saneada. Simular fallo de readiness, fallo de worker, rollback de imagen, migración incompatible, interruptor de retiros, retención de volumen y error de backup. Sólo después revisar para LIVE.

## Fase C (pendiente): habilitación manual de Kali
- Seleccionar SHA de commit de `main` con CI PASS y release/candidata identificable.
- Guardar imagen anterior y respaldos verificables, compilar candidata separada.
- Aprobar plan, ventana y responsabilidades; cambiar API/worker conforme al Compose **real**.
- Validar salud y transacciones sin efectuar payout LIVE de prueba por accidente.
- Si falla la salud, revertir **imagen** cuando es compatible; si falla finanzas/esquema, inmovilizar escrituras afectadas y seguir plan de recuperación y conciliación.

## Qué NO se ha hecho
No se ha instalado runner auto-desplegador, no se ha habilitado `workflow_dispatch` de producción con credenciales, no se ha cambiado Compose, no se ha programado rollback, no se han hecho backups ni cambiado/ejecutado contenedores Kali.
