# TALA EATS — F2.05: /ready desde una red externa (sin cambios en WAF)

**Estado principal:** pendiente de HTTP 200 + JSON `ready/database/redis=true`
desde red externa. Ninguna autoprueba de CI sustituye esa evidencia.

## Diagnóstico pasivo, sin secretos

El archivo `scripts/phase2_external_ready_probe.py` usa únicamente
HTTPS GET al dominio permitido `talaeats.alan-palacios-dev.com`, ruta
`/api/v1/ready`. Rechaza parámetros, credenciales, redirecciones, otros
hosts, URL HTTP y cuerpos mayores de 8 KiB. Comprueba certificados TLS
por defecto. No imprime cuerpos HTML, headers, tokens, IPs o IDs de WAF,
ni cambia Caddy, Cloudflare, firewall, Stripe o Kali.

El workflow **TALA EATS | Kali release preflight** ejecuta siempre las
autopruebas offline (HTTP 200 válido, JSON inválido, 403, 5xx, redirección,
campo ausente/falso y URLs peligrosas). Su `workflow_dispatch` permite
marcar voluntariamente `external_ready_probe=true` para observar el
servidor DESDE GitHub Actions. Si el servidor contesta HTTP 403, el
workflow falla **correctamente**: no indica necesariamente que Kali
esté caído y NO ofrece ni ejecuta bypass del WAF.

## Criterios de cierre del check F2.05

- GitHub Actions manual desde fuera de Kali informa
  `EXTERNAL_READY_OBSERVED` con HTTP 200 y los tres booleanos estrictos.
- Comparar una observación independiente en el host (sólo campos
  `ready/database/redis/version`) para diferenciar origen y edge.
- Revisar reglas Cloudflare/Bot/WAF y Caddy con aprobación humana
  **sin** desactivar protección global ni exponer puertos de DB/Redis.
- Registrar fecha/hora, SHA, enlace del run, origen de la observación
  y evidencia del JSON restringida a campos públicos.
- Mantener F2.06 separada: una respuesta sana no prueba alerta 24/7
  recibida por una persona.

**F2.05 permanece [ ]** mientras el check externo auténtico no dé PASS.
