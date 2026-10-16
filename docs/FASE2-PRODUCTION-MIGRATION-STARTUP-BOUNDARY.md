# Fase 2 — Separación de migraciones y arranque de API (QA aislado)

El entrypoint de la imagen de backend **nunca** debe ejecutar
`alembic upgrade head` en modo `ENVIRONMENT=production`, incluso si
`AUTO_MIGRATE_ON_START` procede de una release antigua, con casing
distinto o espacios accidentales.

## Verificación automática

`backend/tests/test_phase2_production_entrypoint_migrations.py`
ejecuta `/bin/sh backend/entrypoint.sh` con sustitutos de
`alembic`, `uvicorn` y `python` que solo escriben a un fichero
temporal. Verifica:

- Production, PRODUCTION y con espacios no invocan migraciones.
- Las variantes `true/TRUE/yes/1/ON` en producción abortan con
  exit code 78: **ni API ni Alembic** se ejecutan.
- Desarrollo mantiene su ruta de migración local permitida.
- Un comando de mantenimiento explícito (`entrypoint.sh alembic`)
  es independiente del arranque de la API.

La prueba no abre puertos, no invoca SQL ni Docker, no ejecuta
Alembic real y no contacta a Kali. CI nunca provee tokens LIVE.

## Contrato de release pendiente

**No implica** que las migraciones productivas estén autorizadas,
ni que la release efectiva de Kali corresponda a este entrypoint.
Todo `alembic upgrade head` genuino requiere una tarea separada,
backup PG+media fuera de Kali previamente validado, aprobación de
release, mantenimiento y plan reversible/forward-fix. El equipo
debe conservar acceso a la imagen previa y el esquema anterior
o un camino forward-fix probado.

El check técnico de no-auto-migración puede cerrarse tras QA, pero
**F2.02, F2.03 y el GO/NO-GO operativo siguen abiertos** hasta cotejar
el contenedor activo y realizar recuperación real desidentificada.
