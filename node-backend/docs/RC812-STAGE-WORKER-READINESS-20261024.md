# TALA EATS RC8.12 — readiness del worker para checkout y reparto

**Base:** RC8.11 PR #155 (`c6371de9dff6f0e1787f7c61992f0382d831aedb`). Solo candidata GitHub / staging; nada desplegado en Kali por esta PR.

## Problema reproducido en código

Antes, `/api/v1/ready` calculaba `ready = !live || (workerOnline && financialPass)`. Eso significa que cualquier entorno **staging** declaraba HTTP 200 incluso con Redis reportando `workerOnline=false`. Esto era incoherente con el flujo de pagos/entrega, que necesita worker separado para reconciliar Stripe TEST, procesar eventos durables y recuperar READY sin repartidor.

## Nuevo contrato

- Staging con TODOS los flags de checkout/driver en `false`: `workerRequired=false`, `ready=true` siempre que PostgreSQL y Redis estén realmente disponibles (read-only/CI).
- Staging con **algún** flag de checkout de efectivo, Stripe TEST, delivery o conductor en `true`: `workerRequired=true`, `ready=true` solo si existe el heartbeat reciente de Redis.
- Producción: `workerRequired=true`, `ready=true` exige heartbeat y auditoría financiera, como RC8.11. La autorización de dinero real continúa independiente del ready.
- Heartbeat de `src/worker.ts`: `tala:node:stage:worker:heartbeat`, renovado cada 15 s, vence en 45 s. Puede tardar hasta 45 s en detectar la caída; no es una supervisión inmediata.
- En ausencia de DB, Redis o excepción, el endpoint sigue devolviendo HTTP 503, `ready=false` sin filtrar secretos.

La respuesta añade el campo `workerRequired`. Además se instaló un control en la admisión `POST /api/v1/orders` y en la creación de PaymentIntent **Stripe TEST**, que exige un heartbeat `online` en Redis antes de iniciar nuevas operaciones de staging. Si el worker no está disponible o Redis falla, la operación se rechaza HTTP 503 antes de crear un pedido o solicitar un PaymentIntent. Nunca modifica cobros LIVE, pagos, asignación o contabilidad existente.

## Verificación stage tras promover un release, no en producción LIVE

1. Comprobar PM2 API + worker en ejecución y desde red privada `GET /api/v1/ready`: `ready=true`, `workerOnline=true`, `workerRequired=true`.
2. En un laboratorio **aislado** con flags de checkout encendidos, detener SOLO el worker sintético (nunca parar worker LIVE con pedidos/Stripe). Pasados 45 segundos, `GET /ready` debe devolver **503** y `workerOnline=false`, `workerRequired=true`.
3. Reactivar el worker sintético: después de heartbeat válido `GET /ready` debe volver a HTTP 200.
4. Verificar que `GET /api/v1/health` siga respondiendo HTTP 200 sin declarar cobros LIVE autorizados.
5. Volver a ejecutar los gates RC8.11: backend -> restaurante -> conductor -> PIN -> contabilidad, y auditor RC8.9 READY backlog.

**IMPORTANTE:** la protección en `/ready`, `/orders` y Stripe TEST depende del heartbeat con TTL de 45 s, no de una garantía de disponibilidad de extremo a extremo. Si el worker falla después del control puede quedar una solicitud en trámite y debe recuperarse mediante el journal/idempotencia y conciliación. FCM, payouts y habilitación comercial LIVE siguen fuera de alcance. No confundir CI en GitHub con despliegue real.
