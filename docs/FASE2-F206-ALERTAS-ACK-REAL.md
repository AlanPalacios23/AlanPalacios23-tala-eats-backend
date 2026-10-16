# TALA EATS — F2.06: comprobación de recepción REAL de alertas

Estado: **NO-GO operativo**. Este documento no enciende un monitor,
no cambia SMTP/Cloudflare/Kali y no designa responsable de guardia.

## Estados que nunca deben confundirse

1. `SystemAlert` creada en PostgreSQL: incidente detectado.
2. Correo `EmailOutbox.status=pending`: aviso **encolado**, NO enviado.
3. Correo `EmailOutbox.status=sent`: transporte aceptó mensaje; NO demuestra
   entrega al buzón, lectura o recepción por humano.
4. Responsable de guardia autenticado confirmó recepción con prueba:
   **única evidencia válida** para cerrar el check F2.06 junto con supervisión
   24/7 continua. No se puede inventar este ACK en QA.

El campo legado `SystemAlert.notified_at` se marcaba al encolar correo
de gravedad alta/crítica. PR F2.06 impide seguir fabricando ese sello.
Entradas antiguas podrían tener valores obsoletos y requieren auditoría,
NO `UPDATE` automático en producción. La semántica de `notified_at`
solo se podrá reconsiderar cuando exista correlación de evento y
entrega/acuse realmente verificados.

## Matriz mínima de alarmas

| Señal | Prueba simulada requerida | Evidencia operativa |
|---|---|---|
| API pública | error 5xx/timed-out en origen + edge, diferenciar 403 WAF | alerta recibida por guardia |
| Worker heartbeat | heartbeat ausente/retrasado | alarma sin reiniciar worker |
| PostgreSQL | /ready JSON `database=false` en escenario aislado | alarma recibida |
| Redis | /ready JSON `redis=false` en escenario aislado | alarma recibida |
| Outbox / DLQ | backlog alto y mensaje en DLQ | alerta e identificación del evento |
| Errores 5xx y latencia | umbral controlado, sin tráfico real de pagos | alarma y recuperación |
| PSP/conciliación | mismatch sintético con pagos LIVE desactivados | incidencia asignada, sin payout |
| Retiro sospechoso | evento sintético de riesgo, sin CLABE ni transfer | escalamiento documentado |

## Evidencia externa todavía pendiente

- Persona de guardia designada, rota de suplente, cobertura horaria y canal
  confirmado, sin publicar correo o teléfono personal en GitHub.
- Proveedor/canal monitor conectado fuera del host y suficientemente
  independiente de Kali; alerta de prueba entregada desde red distinta.
- Identificador opaco de ticket interno, UTC de emisión y ACK, demora de
  recepción, mitigación, ruta de escalamiento y segunda región cuando aplique.
- Comprobación pública de `/api/v1/ready` con HTTP 200 y JSON correcto,
  preservando WAF. HTTP 403 **no prueba servidor caído**.
- Prueba mensual de recuperación y verificación de falsos positivos.

## Resultado de QA

`backend/tests/test_phase2_alert_delivery_ack.py` verifica en SQLite sintético
que encolar alertas no constituye ACK, que no se finge notificación sin
guardia activa, que los reintentos no duplican alertas abiertas y que sin
SMTP configurado no se confunde cola con aviso enviado. **Aunque pytest
termine PASS, F2.06 debe permanecer [ ]** hasta una notificación realmente
recibida y reconocida por guardia.
