# TALA EATS · Primer gate CI para Backend

## Punto de partida

Repositorio privado separado de las tres apps Flutter. El código está etiquetado como **v1.6.4 PREDEPLOY** y no está verificado byte a byte contra la release que ejecuta Kali; **ningún PASS de CI implica un despliegue o una auditoría de producción**.

## Gate de GitHub Actions

1. Comprueba sintaxis de `backend/app`, migraciones y pruebas con Python 3.13.
2. Escanea archivos de código para rutas privadas, secretos Stripe LIVE, claves privadas, tokens GitHub y credenciales AWS. Prueba el propio escáner con fixtures ficticias.
3. Instala dependencias declaradas y ejecuta `pytest` sobre SQLite **en memoria** con configuración de QA.
4. Ejecuta `connect_security_smoke_v164h1.py` con Stripe simulado y sin operaciones monetarias.
5. No utiliza secretos GitHub, no tiene credenciales de producción, no expone puertos, no instala modificaciones en Kali y no despliega nada. `contents: read` exclusivamente.

**Limitaciones:** SQLite no reemplaza los casos exclusivos PostgreSQL 16 (migraciones, bloqueos, concurrencia o transacciones), Redis y workers reales. Para certificar cobros/Stripe hay que montar staging aislado con Stripe TEST. El repositorio incluye un snapshot saneado para trazabilidad, pero no es un backup validado de la instancia productiva.

## Siguiente fase

- Comparar de forma segura los hashes del contenedor/productive release de Kali con el código PREDEPLOY de GitHub; no exportar secretos, `.env`, base de datos ni fotos.
- Construir QA de PostgreSQL/Redis en Docker con claves sintéticas y tests de migraciones, pedidos idempotentes y outbox.
- Añadir pipeline de análisis de dependencias y contenedor; separar bloqueos de seguridad de errores funcionales.
- Solo después habilitar despliegue manual con aprobación y posibilidad de rollback. Nunca desplegar a través de `push`.