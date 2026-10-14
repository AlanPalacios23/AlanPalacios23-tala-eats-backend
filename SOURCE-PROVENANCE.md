# Procedencia del código

**Fuente:** ZIP de Biblioteca TALA-EATS-BACKEND-v1.6.4-CONNECT-SELF-SERVICE-SECURITY-HOTFIX1-PREDEPLOY.zip

- ZIP original SHA-256: `dc0bbf78d16153ed4abf426b75c006c2e8eff903d42d1aea3f8803306fbefa8f`
- ZIP saneado incluido en `snapshots/`: SHA-256 `302f1f47055da062eb443957edae26e8b40c7892c1ebde107a3272c5211e3805`
- Código backend exportado: 109 archivos de `backend/`, sin `.env`, secretos, backups o imágenes personales.
- **Importante:** el ZIP fuente se identifica como PREDEPLOY. El backend live reportó versión 1.6.4 en `/ready`, pero aún **no hay cotejo de hashes contra el contenedor de Kali**. Este repositorio no es todavía un respaldo verificado bit a bit del código live.
- No ejecutar scripts de despliegue ni habilitar Stripe LIVE desde GitHub. Separar staging de producción.

Para certificar el backend desplegado: verificar el directorio de Docker Compose del contenedor `talaeats-v3-backend-1`, revisar `/ready`, comparar `backend/` de la release activa con el contenido del contenedor y contrastar con este repositorio. No usar `.env.production` ni credenciales.
