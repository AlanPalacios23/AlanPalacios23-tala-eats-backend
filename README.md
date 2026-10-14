# TALA EATS · Backend privado

Este repositorio está destinado a conservar el código de backend FastAPI de **TALA EATS**, aislado del repositorio de las tres aplicaciones Flutter.

## Estado de las fuentes

- La última API **observada mediante lectura** reportó `1.6.4-connect-selfservice-hf1`, `ready=true` (13-oct-2026). Esto solo valida salud de API, **no** la identidad/hash del código Docker desplegado.
- El artefacto disponible en Biblioteca es `TALA-EATS-BACKEND-v1.6.4-CONNECT-SELF-SERVICE-SECURITY-HOTFIX1-PREDEPLOY.zip` (SHA-256: `dc0bbf78d16153ed4abf426b75c006c2e8eff903d42d1aea3f8803306fbefa8f`), con estado **PREDEPLOY**.
- Hasta cotejar la carpeta activa de Kali contra el contenedor `talaeats-v3-backend-1`, el código de aquí debe considerarse **fuente candidata, no snapshot confirmado de producción**.

## Medidas operativas

**No publicar jamás** `.env.production`, archivos `.env` con credenciales, claves Stripe, tokens de administrador, dumps SQL/PG, volúmenes de fotos o datos privados. No activar automáticamente deploy a Kali ni Stripe LIVE mediante GitHub Actions.

Para verificar una copia fiel a producción: consultar `/api/v1/ready`, inspeccionar `docker inspect` y comparar hashes del código ejecutado dentro del contenedor y la release vinculada, excluyendo secretos. Ejecutar esta verificación desde Kali con el exportador aprobado, fuera de la aplicación productiva.

Este repositorio es **privado**. Las fuentes se revisarán y copiarán en una ruta `backend/` y un artefacto `snapshots/` con etiqueta PREDEPLOY.
