# TALA EATS · Repositorio Backend

> **Actualización operativa 21/22-oct-2026:** la **API pública principal de Tala Eats** ahora apunta a **Node.js RC6**, no al backend FastAPI de esta rama `main`. URL externa verificada por el operador en Kali: **`https://talaeats.alan-palacios-dev.com/api/v1`** → Cloudflare Tunnel → **`127.0.0.1:18190`**. El código desplegado en PM2 es **`30ab51b587b21127c3f3419e0ec4c3a8539dfb0a`**. Los seis contenedores del proyecto Docker Python `talaeats-v3` fueron retirados; **se conservaron respaldos, volúmenes, imágenes y releases**.
>
> **DOCUMENTACIÓN OPERATIVA ACTUAL (rama Node):** [Node RC6 público, evidencias de Kali, inventario y retiros del legado](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/blob/feat/node-kali-direct-pm2-release-20261020/node-backend/docs/KALI-NODE-RC6-PUBLIC-API-AND-LEGACY-RETIREMENT-20261022.md). Código Node: [`node-backend/` en la rama de release](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/tree/feat/node-kali-direct-pm2-release-20261020/node-backend).
>
> **IMPORTANTE:** Node está publicado pero continúa en **staging** (`productionReady=false`, `financialWrites=false`, `onlinePaymentsEnabled=false`). No hay paridad comercial integral ni migración de datos Python→Node acreditadas. No habilitar Stripe LIVE ni dar por funcionales todas las apps por el solo hecho de recibir HTTP 200.

## Código FastAPI de esta rama `main` — archivo histórico

El código Python FastAPI de `main` se conserva **como referencia/legado**, no como evidencia del backend que responde hoy en el hostname público. Las notas siguientes describen el estado antiguo **antes del retiro de Docker**; no deben usarse para revivir Python ni borrar respaldos.

Este repositorio conserva el código histórico FastAPI de **TALA EATS**, aislado del repositorio de las tres aplicaciones Flutter.

## Estado de las fuentes

- La última API **observada mediante lectura** reportó `1.6.4-connect-selfservice-hf1`, `ready=true` (13-oct-2026). Esto solo valida salud de API, **no** la identidad/hash del código Docker desplegado.
- El artefacto disponible en Biblioteca es `TALA-EATS-BACKEND-v1.6.4-CONNECT-SELF-SERVICE-SECURITY-HOTFIX1-PREDEPLOY.zip` (SHA-256: `dc0bbf78d16153ed4abf426b75c006c2e8eff903d42d1aea3f8803306fbefa8f`), con estado **PREDEPLOY**.
- Hasta cotejar la carpeta activa de Kali contra el contenedor `talaeats-v3-backend-1`, el código de aquí debe considerarse **fuente candidata, no snapshot confirmado de producción**.

## Medidas operativas

**No publicar jamás** `.env.production`, archivos `.env` con credenciales, claves Stripe, tokens de administrador, dumps SQL/PG, volúmenes de fotos o datos privados. No activar automáticamente deploy a Kali ni Stripe LIVE mediante GitHub Actions.

Para verificar una copia fiel a producción: consultar `/api/v1/ready`, inspeccionar `docker inspect` y comparar hashes del código ejecutado dentro del contenedor y la release vinculada, excluyendo secretos. Ejecutar esta verificación desde Kali con el exportador aprobado, fuera de la aplicación productiva.

Este repositorio es **privado**. Las fuentes se revisarán y copiarán en una ruta `backend/` y un artefacto `snapshots/` con etiqueta PREDEPLOY.
