# TALA EATS — Recuperación de V3 tras 502 (NO EJECUTAR EN PRODUCCIÓN SIN APROBACIÓN)

**Estado al 19-oct-2026:** guía de recuperación, sin deploy ni modificación de Kali desde GitHub. La automatización PM2 staging sigue deshabilitada y la PR #79 en DRAFT.

## Atestaciones del servidor Kali

- GREEN API healthy; no usarla como excusa para modificar enrutamiento ni datos.
- Backend V3 estaba reiniciándose (833 reinicios, exit 1, OOM=false); el proxy local Caddy en 127.0.0.1:8082 y Cloudflare daban HTTP 502.
- API y worker V3 comparten exactamente la misma `DATABASE_URL`, que **no incluye user, password ni database**. La resolución DNS, conectividad TCP al DB V3 y red compartida pasaron. Su autenticación con esa URL falla con OperationalError.
- Docker DB V3 health y pg_isready PASS. `POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_PASSWORD` declarados en DB coinciden con los de ambos archivos protegidos `.env.production` (release v1.6.4 y legacy).
- `POSTGRES_TCP_SELECT1=PASS` dentro de DB con contraseña declarada; y ahora **`WORKER_AUTH_SELECT1_PASS`** desde worker V3 sobre la red Docker usando estas credenciales enviadas solo por STDIN (no mostrado ni guardado). Queda demostrada la viabilidad de autenticación. **No** demuestra todavía boot de FastAPI, ni migración, ni readiness.
- API y worker V3 se crearon usando `docker-compose.cloudflare.yml` de v1.6.4 y un archivo temporal `/tmp/tala-deploy-hd4nyo23/release-override.yml`, hoy **ausente**. DB V3 procede del `docker-compose.staging.yml` legacy. Los tres servicios tienen project label `talaeats-v3`. **Nunca usar `docker compose up` en este estado.**

## GO/NO-GO antes de reconstruir API/worker

1. **Congelar los artefactos e inventariar el estado efectivo, solo lectura:** IDs de imagen actuales de API y worker; servicios `talaeats-v3`; redes Docker compartidas; binds, volúmenes y puertos Caddy/API; etiquetas `com.docker.compose.*`; políticas de reinicio y límites de recursos. No imprimir Env ni `docker inspect` completo en el chat.
2. **Confirmar copias y recuperación:** backup PostgreSQL V3 y fotos efectivamente cifrado, prueba de restauración aislada, retención de imágenes actuales (no solo tags); verificar que GREEN permanece healthy y tiene sus propios volúmenes. Sin prueba de restauración y plan de rollback, NO-GO.
3. **Reconstruir el override SOLO en un archivo privado del host**, bajo un directorio restringido del operador (0700) con permiso 0600. Nunca en repo público, chat, tickets o logs. Derivar de la configuración actual y la fuente aprobada, no simplemente inventar un Compose nuevo. En particular, preservar todas las configuraciones no relacionadas (security caps, env_file, restart, networks, command, healthcheck, mounts, rate limits, service aliases, servicios Caddy/DB/Redis). **No copiar Docker env completo a GitHub.**
4. **Crear la conexión explícita** de API y worker hacia **la misma** DB V3 usando credenciales existentes que funcionaron desde el worker, con los caracteres especiales de URL debidamente codificados. No cambiar contraseña de PostgreSQL ni usar bases/volúmenes de GREEN.
5. **Validación offline / dry run antes de tocar runtime:** `docker compose config --quiet` con la lista COMPLETA de archivos y opciones; comparar salida normalizada, capturada localmente sin imprimir secretos, contra la configuración actual y mostrar solo diferencias saneadas. Confirmar que los servicios DB, Redis, Caddy, frontend y ADMIN no se recrearán. Confirmar que backend no ejecuta migraciones automáticas (verificar entrypoint de la imagen REAL, no asumir que coincide con GitHub main).
6. **Aprobación operacional separada:** ventana, copia y rollback, cambios exactos, SHA de artefacto, imágenes/tag anteriores. Solo entonces recrear **exclusivamente** API y worker V3 bajo supervisión y verificar health local, `/api/v1/ready`, worker y público. Revertir solo código/servicio si esquema compatible; nunca rollback de migraciones/DB financieras automáticamente.

### Verificación inmediata SIN mutaciones

Comprobar que el archivo Compose principal al menos se puede analizar con el archivo de variables ya existente sin imprimir configuración:

```bash
RELEASE=/home/alan/talaeats-releases/TalaEats-Web-v1.6.4-CONNECT-SELF-SERVICE-HF1-LIVE
if docker compose -p talaeats-v3 --project-directory "$RELEASE" --env-file "$RELEASE/.env.production" -f "$RELEASE/docker-compose.cloudflare.yml" config --quiet >/dev/null 2>&1; then
  echo TALA_V3_BASE_COMPOSE_PARSE=PASS
else
  echo TALA_V3_BASE_COMPOSE_PARSE=FAIL
fi
```

**Esto no valida paridad del override ausente**; ni `PASS` ni `FAIL` autorizan un recreado. Los valores de `.env.production` y los Docker inspect/env permanecen en Kali y nunca deben mostrarse.

## Staging PM2 permanece separado

El agente de staging en PR #79 es una automatización aparte; no debe recibir acceso a Docker LIVE ni aplicar cambios al stack V3, y debe usar usuario Linux, PostgreSQL y Redis separados. La reparación de V3 y el despliegue staging requerirán decisiones y pruebas independientes.
