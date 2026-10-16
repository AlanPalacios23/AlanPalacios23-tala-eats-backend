# F2.11 — Verificación comercial efectiva en Kali, sin modificar pagos

**Estado de certificación:** PENDIENTE de ejecución real en el servidor y
conciliación PSP/banco. Este archivo prepara únicamente la comprobación.

## Contrato
El backend v1.6.4 tiene precios por defecto para el plan 1.6.2, pero
`SystemSetting` puede sobrescribirlos. No basta verificar `DEFAULTS`:
se debe comprobar que **los dos flags** `COMMERCIAL_PRICING_V152_ENABLED`
y `COMMERCIAL_PRICING_V162_ENABLED` están activados realmente en el
contenedor de la API y que no hay overrides incompatibles en PostgreSQL.

| Concepto | Requerido en MXN |
|---|---:|
| Comisión restaurante | 15% |
| Servicio | 7% |
| Tope servicio | $25 |
| Envío hasta 2 km | $35 |
| Distancia incluida | 2 km |
| Envío por km adicional | $5 |
| Pago repartidor hasta 2 km | $32 |
| Pago repartidor por km adicional | $4 |

El verificador del repositorio `scripts/phase2_pricing_runtime_readonly.py`
falla con NO-GO si faltan flags, cambia la versión, el contenedor no pertenece
a `talaeats-v3/backend`, la base no es PostgreSQL o aparece un override
incompatible, NaN, Infinity o no numérico.

**Autoprueba CI sin red, Docker o DB:**

```bash
python3 scripts/phase2_pricing_runtime_readonly.py --self-test
```

**Para el operador autorizado, desde checkout auditado en Kali:**

```bash
python3 scripts/attest_kali_live_readonly.py --repo .
python3 scripts/phase2_pricing_runtime_readonly.py --on-kali
```

El segundo comando usa únicamente `docker inspect` de etiquetas/estado y
`docker exec ... python -c` en el contenedor API YA EXISTENTE para ejecutar
`SELECT` en transacción PostgreSQL **READ ONLY**. Solo emite estado
sanitizado (sin API keys, clientes, bancos, balances, nombres de comercios o
valores arbitrarios de settings). No ejecuta checkout, cobros, actualiza
configuración, migraciones, respaldos ni transferencias. No tiene opciones
de despliegue. Una discrepancia produce salida NO-GO sin cambio correctivo.

## Qué NO certifica un PASS

Un PASS del verificador indica **solo** flags + parámetros comerciales
efectivos *observados* en el contenedor API de Kali que se consultó.
La política puede variar con promociones, roles, tipo de envío, distancia,
y configuración de restaurante. Todavía se necesita comparar checkout
público, pedidos nuevos sintéticos **en staging** y ledger contra IDs
auténticos de Stripe TEST / Mercado Pago sandbox y conciliación del
beneficiario. Los pagos LIVE y la conciliación bancaria no son objeto de
este script.

El check F2.11 principal permanece [ ] hasta la evidencia operativa
y financiera completa, vinculada al SHA de código realmente desplegado.
