# TALA EATS Backend · F1.09 — inventario y controles de datos

**Revisión técnica:** 15/oct/2026. **Rama:** `work/fase1-hardening-sin-workflows-20261015`. No contiene datos personales reales ni credenciales. **Alcance:** rutas API, acceso por rol, persistencia media/DB, retención y solicitudes del titular. Este documento es una auditoría técnica, **no una declaración de cumplimiento jurídico ni una política aprobada**.

## Inventario mínimo y superficie de ataque

| Datos | Almacenamiento y flujo | Acceso autorizado esperado | Estado técnico / exposición |
|---|---|---|---|
| Cuenta, correo, teléfono, contraseña | PostgreSQL `users`, hash de contraseña PBKDF2 | Titular + admin estrictamente necesario | Login usa contraseñas hasheadas; restablecimiento revoca sesiones |
| JWT, sesiones y dispositivo | `device_sessions` (hash del token, no token), cookies HttpOnly, JWT firmado | Solo sesión del titular, auditoría interna mínima | Logout y revocación por dispositivo; mantener cookies Secure/TLS en despliegue |
| 2FA/OTP y restablecimiento | PostgreSQL / secreto TOTP; token reset hasheado | Titular y servicio de autenticación | 2FA obligatoria para roles privilegiados en producción; proteger backups y claves |
| Pedidos y domicilios | `orders`, `order_items`, domicilio, coordenadas de entrega, detalles de contacto | Cliente dueño; restaurante/repartidor asignado; ADMIN justificado | Endpoints de pedidos requieren auth/roles; no exponer domicilios en logs, exports públicos o alertas |
| Localización GPS | Redis (ubicación operativa), coordenadas de repartidor en PostgreSQL | Cliente del pedido ACTIVO con asignación vigente; repartidor; ADMIN justificado | PR #40 exige ping reciente y no expone posición fuera de pedido activo; falta retención/depuración controlada |
| Documentos fiscales/identidad para alta | `media/onboarding`, `onboarding_applications.documents_json` | Usuario que **subió** archivo y lo asoció exactamente a su solicitud; ADMIN autorizado | PR #44 revisada: URL exacta, prefijo aleatorio vinculado al usuario, bytes limitados, tipo y magic verificados; sin exposición estática |
| Prueba fotográfica de entrega | `media/delivery-proofs`, referencia `delivery_proofs.photo_url` | Cliente del pedido, driver asignado, propietario del restaurante o ADMIN | GET autenticado, `Cache-Control: private, no-store`; existe fase previa sin asociación para archivos huérfanos |
| Fotografías de chat | `media/chat-media` y `chat_messages.media_url` | Participantes de pedido y admin | GET exige mensaje asociado y permiso de pedido; no caché pública |
| Fotos de catálogo/portada | `media/catalog`, URL pública | Público para fotos de comercio, escritura únicamente propietario | Contenido público deliberadamente; validar que nunca contenga documentos de identidad |
| Cuentas bancarias, Connect, CLABE | Stripe Connect (gestión KYC externa), PostgreSQL guarda refs de cuenta y destino | Beneficiario dueño y personal de finanzas autorizado | Links Stripe https verificados, cliente recibe solo banco/últimos 4 dígitos; no almacenar CLABE en app/backend |
| Ledger, retiros y conciliación | `withdrawal_requests`, `audit_events`, ledger y webhooks | Beneficiario propio, ADMIN financiero, worker firmado | No marcar retiro `paid` sin confirmación del PSP; LIVE deshabilitado hasta GO externo |
| IP, dispositivo, auditoría y fraude | `DeviceSession.ip_hint`, flags, AuditEvent, métricas y logs | Seguridad y soporte autorizado por rol | Evitar incluir JWT, dirección, fotos, CLABE o OTP en logs y alertas |

## Auditoría de endpoints de archivos

| Ruta | Auth / propietario / controles | Resultado |
|---|---|---|
| POST `/api/v1/uploads/onboarding-document` | usuario autenticado; tamaño y magic; nombre aleatorio prefijo `u<ID>` | Mecanismo de emisión controlado |
| POST `/api/v1/operations/onboarding` | usuario autenticado; F1.09 comprueba cada URL **propia, exacta, existente y sin duplicados** antes de vincularla | Cambio de seguridad añadido en PR #44 |
| GET `/api/v1/uploads/onboarding-document/{filename}` | auth; admin o propietario original con referencia exacta en JSON de su solicitud | Cambio de seguridad añadido; elimina comparación por subcadena de JSON |
| POST `/api/v1/uploads/delivery-proof` | driver/admin; magic y tamaño, archivo aleatorio | Guardar; queda sin asociación hasta referenciarlo |
| GET `/api/v1/uploads/delivery-proof/{filename}` | auth; participante real o admin; `no-store` | Acceso privado |
| POST/GET `/api/v1/uploads/chat-media/{order_id|filename}` | acceso al pedido; tamaño/magic; descarga por media registrada | Acceso privado |
| POST `/api/v1/uploads/catalog/*` | solo dueño de restaurante; validación tipo/tamaño | Alta autorizada |
| GET `/api/v1/uploads/catalog/{filename}` | público, imagen de catálogo; caché inmutable | Público intencional |

**Tests ligados al audit:** `backend/tests/test_onboarding_document_isolation_phase1.py` (dos cuentas, archivo privado, intento de referencia ajena, URL forjada, registro legacy y magic) y `test_auth_bank_security_phase1.py` (sesiones, 2FA, propiedad bancaria).

## Conservación/borrado: propuesta para aprobación jurídica y operativa

No hay evidencia de una política completa automatizada de retención/purga para todas estas clases de datos. **No afirmar que ya se borran en un plazo concreto.** Antes del piloto debe definirse y aprobarse por escrito:

1. **Finalidad y minimización:** GPS solo durante prestación y ventana de aclaración justificada; no mostrar ni guardar rutas de servicio indefinidamente por defecto.
2. **Fotografías/chat/documentos:** categorías separadas; plazo vinculado a reclamaciones, obligaciones contractuales y fiscales, acceso al titular y borrado/anominización al vencer la base legal; sin eliminar pruebas legítimas de una disputa vigente.
3. **Finanzas y fiscal:** preservar registros contables inmutables por el plazo aplicable, aplicar disociación de PII cuando corresponda, no borrar ledger a solicitud de usuario si hay obligación de conservación.
4. **Seguridad:** rotación de claves/backup, logs sin secretos ni PII sensible, restricciones para soporte y acceso administrativo, documentación de encargados/proveedores (hosting, Cloudflare, Stripe y mensajería).
5. **Derechos ARCO y avisos:** canal documentado para acceso, rectificación, cancelación y oposición cuando proceda, verificación de identidad, resolución y bitácora de respuesta; someter texto y plazos a asesoría legal mexicana.
6. **Borrado seguro:** purga coordinada de archivos, índices SQL, backups según su ciclo aprobado, huérfanos de uploads, tokens y cachés Redis. Debe ser idempotente, auditada y ejecutarse después del periodo legítimo.

## Brechas y condiciones de cierre

- [x] Inventario de tipos de datos, rutas, RBAC actual, riesgos y controles propuestos documentados en este archivo.
- [x] Endpoints de archivos auditados; se preparó y probó el parche que evita apropiación de documentos privados **cuando los tests correspondientes estén en PASS**.
- [ ] Aprobación jurídica del plazo de retención por clase de datos, aviso de privacidad, contratos de encargados y ARCO.
- [ ] Política técnica de purga de datos personales/archivos huérfanos implementada en entorno aislado y probada con rollback.
- [ ] Verificar que Caddy no exponga la ruta `media/onboarding` ni `delivery-proofs` como archivos estáticos.
- [ ] Revisar políticas de acceso y backup en la instancia Kali realmente desplegada.

El registro **F1.09 técnico** puede certificarse después de un QA Linux PASS del archivo y del parche asociado, **sin certificar la ley, el deploy ni retención automática**. Los requisitos externos siguen abiertos como dependencias de salida de Fase 2/3.
