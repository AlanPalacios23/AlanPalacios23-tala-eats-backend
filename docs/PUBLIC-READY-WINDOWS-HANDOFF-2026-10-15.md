# Diagnóstico /ready — continuación segura de PR #20 (issue #21)

Esta PR apilada sobre `release/p0-checklist-last-four` prepara un **diagnóstico manual** para mañana sin consumir minutos de GitHub-hosted Actions hoy.

## ¿Por qué eliminamos el cron cada 15 minutos?

El workflow previo ejecutaba `schedule: */15 * * * *` (hasta 96 ejecuciones diarias) y `push` sobre rama de laboratorio. Mientras la salida externa de `/ready` no está validada, esos trabajos solo generan ruido y consumo. Esta PR utiliza **`workflow_dispatch` exclusivamente**. No proporciona monitoreo continuo: ese servicio se debe configurar aparte con un monitor adecuado y entrega real de alertas, o un runner self-hosted autorizado.

## Mejoras

- Desactiva redirecciones HTTP: respuesta 302/307 de página de Cloudflare o login queda categorizada `HTTP_302`/`HTTP_307`, nunca aceptada como API sana.
- Límite de respuesta de 16 KiB y Content-Type `application/json`; diagnostica `PAYLOAD_TOO_LARGE` o `NON_JSON_CONTENT_TYPE`.
- No imprime cuerpo, tokens, headers, exceptions crudas ni URLs de respuesta.
- Mantiene validación `ready=true`, `database=true`, `redis=true`, `version` no vacía.
- Autotests con HTTP y DNS **sintéticos**. No hay acceso automático a producción.

## Ejecutar en el equipo Windows mañana

En checkout de esta rama (que depende de PR #20):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\qa-readiness-windows.ps1
```

Eso prueba **sin consultar internet**. Para un chequeo GET explícito desde la red del equipo:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\qa-readiness-windows.ps1 -Probe
```

## No cerrar #21 hasta

- [ ] Respuesta HTTP 200 con JSON sano desde GitHub/otra red, no únicamente desde Kali.
- [ ] Diagnóstico de DNS/TLS/Cloudflare y reglas WAF sin hacer cambios automáticos.
- [ ] Confirmar entrega real de alerta a persona responsable, no solo evento en cola.
- [ ] Definir monitoreo 24/7 con costo y límites explícitos.

No despliega ni reinicia Kali, no edita tunnel/Cloudflare, no toca datos o dinero.
