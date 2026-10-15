# TALA EATS · Fase 1 P0 — condiciones de aprobación y promoción (15/oct/2026)

**Estado:** CI/GitHub aislado. NO es autorización de desplegar en Kali, modificar Cloudflare, habilitar pagos ni transferir dinero. Este registro acompaña [PR #46](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/pull/46) y el [plan maestro #43](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/43).

## F1.01 checkout exacto
- Con `client_reference`: adquirir `SELECT users.id FOR UPDATE` **antes** de consultar si existe referencia; persistir HMAC de la intención de checkout en el mismo COMMIT del pedido.
- Repetición idéntica devuelve el mismo pedido; contenido cambiado responde 409; ni 500 ni descuento de stock duplicado. Los pedidos legacy sin huella exigen comparación conservadora; gift-card legacy responde 409 y el cliente debe consultar `/orders/mine`.
- **Riesgo reconocido:** la huella utiliza `JWT_SECRET` de la release; una rotación de la clave cambia la huella. No rotar la clave sin versión/política de HMAC antes de promover. Esto falla cerrado y no permite cobrar doble, pero puede impedir replay exacto. No almacenar ni exponer códigos de regalo, JWT ni HMAC en logs.
- [F1.06]: verificar dos workers Uvicorn, 8 concurrentes, Redis activo/inaccesible y corte de respuesta **después del COMMIT** en CI con PostgreSQL16 efímero.

## F1.02 migración segura
- En producción `backend/entrypoint.sh` no llama Alembic ni crea un admin. Niega `AUTO_MIGRATE_ON_START=true`.
- Preparado `backend/scripts/approved_migration.sh` para **ejecución manual desde un checkout con git y entorno Python**; exige consentimiento explícito, ticket de cambio, SHA Git completo idéntico al aprobado, backup no vacío con digest SHA256 verificado y restauración atestada por operador.
- No invocar esta utilidad desde workflows automatizados ni reemplazarla por `docker compose up --build`. Antes de usar en Kali se necesita revisar entorno real, respaldar DB/media, comprobar restauración aislada y esquema vigente; cambiar `.env.production` solo con plan de migración aprobado.
- La utilidad es un **control procedural**, no demuestra automáticamente que una copia cifrada pueda restaurarse.

## F1.03 identidad de red y Caddy
- La app no consume cabeceras CF/XFF directamente para calcular identidad del limitador: confía en `scope.client`, procesado por Uvicorn **solo desde peers en `UVICORN_FORWARDED_ALLOW_IPS`**.
- **Bloqueador externo no verificable solo con Actions**: validar en Kali la IP/subred exacta de la conexión Caddy→backend; asegurar que el backend no esté abierto a internet directamente; comprobar que Caddy **elimine/sobrescriba** X-Forwarded-For enviado por visitante y que Cloudflare indique visitante real solo cuando la petición venga del Tunnel de confianza.
- Probar mismo visitante desde dos IP forjadas; el rate-limit debe contabilizarlas como una identidad si procede, con clientes reales diferenciados únicamente a través de proxy verificado.
- **No establecer el wildcard `*`** ni configurar una IP de Caddy por adivinación. La ruta externa `/api/v1/ready` devolvió 403; diferenciar Cloudflare/WAF/Caddy/origen antes de intervenir.
- Si no se determina upstream real, **NO desplegar la candidata ni marcar F1.03**; usar Issue #21.

## F1.04 finanzas legacy
- Denegados en producción los mutantes `/operations/admin/payouts/run`, `mark-paid`, `cash-settlements/run`, `cash-settlements/{id}`, `/v11/admin/payouts/dispatch` y su webhook legacy.
- **No** bloquea Stripe Connect webhook moderno (firma y conciliación propias), pero **no lo habilita ni autoriza payouts LIVE**.
- Impacto a revisar: administradores que usen los endpoints legacy dejarán de poder crear/cerrar cortes después de este cambio. Para piloto deben acordar **procedimiento contable legal de conciliación y liquidación** antes de promover. Mantener `WITHDRAWALS_LIVE_ENABLED=false` y flags de transferencia inactivos.

## F1.08 y F1.10 publicación sin despliegue
- Cada commit final deberá ejecutar Linux/Python3.13 pytest completo, sintaxis+secretos, OSV/Bandit, PostgreSQL16/Redis8/Alembic, pruebas POSIX, F1.06 multiworker/red y finanzas NO-GO, y Docker non-root/smoke.
- CI Docker archiva la imagen probada como artifact GitHub v4 **inmutable durante retención de 90 días**, junto con SHA256 y provenance que identifican el `github.sha` real (en PR puede ser merge-ref temporal). No usar un Docker tag mutable como identificador suficiente.
- La candidata final debe usar **el SHA de `main` después de merge** y su propio artifact/digest, o un tag/branch de release que apunte a ese commit exacto. El SHA de PR de la rama NO equivale a SHA de merge de main.
- Registrar riesgos y rollback: conservar API+worker anterior, migraciones DB únicamente por fase separada, nunca restaurar DB LIVE con asientos posteriores al backup, nunca hacer `alembic downgrade` automático.
- **Todo esto certifica candidato para ensayos**, NO lanzamiento comercial ni que el servidor Kali ejecute esas fuentes.

## Gate final pendiente fuera de GitHub

- [ ] Revisión humana de topología real, Caddy, Cloudflare y rutas origen.
- [ ] Copia cifrada PostgreSQL+fotos fuera del host, restauración probada y conciliación.
- [ ] Selección del mecanismo real y documentado para liquidación/payouts; ninguna transferencia LIVE automática.
- [ ] Atestación de imagen y release efectiva en Kali y ensayo controlado de rollback.
- [ ] GO/NO-GO de lanzamiento y ventana de promoción autorizada por responsable.
