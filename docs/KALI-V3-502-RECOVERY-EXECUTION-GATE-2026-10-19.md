# TALA EATS V3 · Recuperación supervisada de API y worker · 19-oct-2026

> **Estado:** Preparado, **NO AUTORIZADO PARA EJECUCIÓN**. La PR #79 sigue DRAFT.
> No invocar `docker compose up` hasta que el operador apruebe expresamente la intervención productiva y se compruebe nuevamente el GO/NO-GO.

## Evidencia del servidor Kali (no de GitHub Actions)

**Causa probable del 502:** La imagen de backend v1.6.4 no logra iniciar porque el `DATABASE_URL` LIVE de backend y worker tiene host válido de V3 pero carece de usuario, contraseña y nombre de base de datos. El Compose principal con `.env.production` SÍ renderiza los tres campos correctos; las credenciales originales pasan `SELECT 1` desde la red Docker del worker. El override temporal que creó esos servicios desapareció, no se debe ejecutar el Compose base solo.

**Candidato privado local:** `~/.local/share/talaeats/v3-recovery-private/v3-api-worker-restore-candidate.yml`, permisos 0600, carpeta 0700. No trasladar al repo, logs ni al chat. Generado por `kali_v3_prepare_private_restore.py` y validado localmente:
- imagen de backend y worker fijada mediante el SHA256 de las imágenes cacheadas y actualmente utilizadas;
- `DATABASE_URL` corregida desde el Compose principal, validada contra las credenciales V3 originales;
- `REDIS_URL` exactamente la de los contenedores V3 LIVE, cuyo alias de red se validó contra Redis V3;
- otras variables explícitas de entorno sin diferencias; red y fuentes/destinos de mount coinciden;
- `docker compose config --format json` PASS;
- `docker compose --dry-run ... up --no-deps --no-build --pull never -d backend` PASS;
- `docker compose --dry-run ... up --no-deps --no-build --pull never -d worker` PASS;
- `docker compose --dry-run ... up ... backend worker` FALLA porque worker depende de backend `condition: service_healthy` y backend actual está `restarting/unhealthy`.

**Respaldo DB real y prueba de recuperación:**
- protegido en `~/.local/share/talaeats/v3-recovery-private/backups/v3-pre-recovery-20261019T023723Z.dump`, 0.31 MB;
- `pg_dump -Fc` PASS, `pg_restore --list` PASS;
- restauración **real** en contenedor PostgreSQL efímero aislado, sin red ni puertos publicados, PGDATA `tmpfs`: `FULL_RESTORE pass`, `RESTORED_TABLES_VALIDATED pass`, `RESTORED_TABLE_COUNT 68`, `SCRATCH_CONTAINER_CLEANED yes`, `ISOLATED_RESTORE_TEST PASS`.
- Esta prueba confirma que el **dump de la DB** puede restaurarse. **No** cubre necesariamente archivos/fotos, Redis, backups fuera del host, recuperación completa del backend o tests integrales de pagos.

## Estrategia de ejecución aprobable — sin ejecutar todavía

1. Operador confirma que entiende que la operación **sí modifica la producción V3** (recreará los contenedores API y worker) y da autorización específica. No basta con un PASS de GitHub Actions ni con una simulación.
2. Inmediatamente antes de intervenir: releer identidad de `talaeats-v3-backend-1`, `talaeats-v3-worker-1`; image ID en Docker (deben coincidir con el candidato privado); verificación permisos privados 0700/0600, backup existente; salud de DB/Redis/Caddy, y estado de GREEN. Confirmar que no hay despliegue paralelo y ventana operativa.
3. Registrar localmente, con permisos 0600 y sin compartir: IDs de imagen, `sha256sum` del dump, la configuración privada del candidato, plan de rollback. Guardar referencias actuales del servicio, nunca añadir secretos a GitHub. Evitar permisos amplios de lectura.
4. Validar `config --quiet` **con base + candidato** y dry run solo `backend`. No usar `down`, `up` global, `--build`, `--pull always` ni `--remove-orphans`.
5. **Recrear únicamente `backend`** vía `docker compose ... up --no-deps --no-build --pull never --force-recreate -d backend`. La CLI Compose y toda la configuración (incluyendo project, project-directory, env-file, base y overlay) deben ser las mismas aprobadas; no manipular DB/Redis/Caddy/frontend/admin/GREEN.
6. Comprobar estado Docker backend y healthcheck; consultar HTTP LOCAL `http://127.0.0.1:8082/api/v1/health` y `/api/v1/ready`. Debe observarse estable en varios chequeos; **no** continuar a worker ante errores/health unhealthy o discrepancias de versión/esquema. Inspeccionar logs sólo de forma saneada, no exponer variables ni secrets.
7. Solo con backend healthy y autorización vigente: recrear únicamente `worker` con los mismos argumentos de seguridad; validar que está running, que la cola/Redis responde, y que no hay excepciones de autenticación. Verificar de nuevo health/ready LOCAL y HTTPS público tras estabilización.
8. **Rollback controlado:** conservar ambas imágenes anteriores y copia cifrada / privada de la configuración del servicio. Si un contenedor nuevo falla, evitar cambios especulativos en DB, restauraciones automáticas o migraciones de vuelta. Diagnosticar; si procede, volver a la imagen anterior/configuración efectiva conocida sin alterar el esquema. La configuración LIVE anterior tenía un URL de PostgreSQL defectuosa, por tanto reponerla no recupera funcionalidad: considerarlo degradación/reversión, no recuperación. Confirmar pasos concretos con operador.
9. Una vez recuperado V3, auditar impacto de multimedia/volúmenes y el dump, y SOLO DESPUÉS retomar PM2 staging aislado. Ningún cambio de Stripe LIVE, pagos, contabilidad, bancos, payout, balances o apps móviles.

## GO/NO-GO a fecha del documento

| Requisito | Resultado |
|---|---|
| URL base PostgreSQL y auth Docker V3 | PASS |
| Redis V3 preservado | PASS |
| Images sha256 actuales en caché | PASS |
| Compose candidato privado resuelto | PASS |
| Simulación individual backend | PASS |
| Simulación individual worker | PASS |
| Diagnóstico simulación conjunta | Comprendido: backend unhealthy y dependencia service_healthy |
| Backup DB `pg_dump -Fc` | PASS |
| Restauración aislada y 68 tablas | PASS |
| Plan de rollback/retención local imágenes | Documentado; preservación operativa pendiente |
| Aprobación explícita de recreación LIVE | **PENDIENTE** |
| Recuperación HTTPS/health | **PENDIENTE** |

**Control principal:** no afirmar que la API pública está reparada hasta obtener `/api/v1/health`, `/api/v1/ready` y salud del worker comprobados tras intervención.
