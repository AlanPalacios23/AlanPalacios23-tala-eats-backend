# Procedencia del código

**Fuente:** ZIP de Biblioteca TALA-EATS-BACKEND-v1.6.4-CONNECT-SELF-SERVICE-SECURITY-HOTFIX1-PREDEPLOY.zip

- ZIP original SHA-256: `dc0bbf78d16153ed4abf426b75c006c2e8eff903d42d1aea3f8803306fbefa8f`
- ZIP saneado incluido en `snapshots/`: SHA-256 `302f1f47055da062eb443957edae26e8b40c7892c1ebde107a3272c5211e3805`
- Código backend exportado: 109 archivos de `backend/`, sin `.env`, secretos, backups o imágenes personales.
- **Atestación en Kali (15/10/2026, ejecutada por el operador):** el verificador `scripts/attest_kali_live_readonly.py` comprobó **71 archivos de runtime idénticos** entre GitHub commit `e22e4d5626c153d325b8f80278569b3534ecd652` y el contenedor activo `talaeats-v3-backend-1`; `missing=[]`, `extra=[]`, `mismatch=[]`, `full_source_match=true`, `ready=true` y versión `1.6.4-connect-selfservice-hf1`. Migraciones PostgreSQL `alembic current` y `heads` coincidían en `f21i00000001 (head)`; contenedor `running` y `healthy`.
- **Alcance de la evidencia:** esta comparación NO cubre `.env`, base de datos completa, volúmenes de fotos, secretos, configuración de Compose, imágenes descargadas, operaciones Stripe LIVE o restaurabilidad de backups. Posteriormente el commit `710e97f8ecd1b8a65f7bffd2f5fa00c6eaa2836e` agregó exclusivamente pruebas/CI, sin cambiar el código runtime validado.
- No ejecutar scripts de despliegue ni habilitar Stripe LIVE desde GitHub. Separar staging de producción.

Para futuros despliegues: repetir cotejo de hash, inventariar Compose con `scripts/kali_release_inventory_readonly.sh`, respaldar/validar restauración, y promover imagen y worker con revisión manual; ver `docs/KALI_GITHUB_RELEASE_ROLLBACK.md`. Nunca publicar `.env.production` ni credenciales.
