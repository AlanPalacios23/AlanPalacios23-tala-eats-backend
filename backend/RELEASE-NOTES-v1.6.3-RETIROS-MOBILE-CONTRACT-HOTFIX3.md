# TALA EATS Backend v1.6.3 Mobile Contract HOTFIX3 · PREDEPLOY

Partiendo de HOTFIX2, añade al `GET /api/v1/withdrawals/{role}/{recipient_id}/balance` únicamente información de lectura proveniente de Stripe y del servidor:
`bank: {status, bank_name?, last4?}`, `limits: {minimum_cents, per_request_cents, daily_remaining_cents}`, `server_allows_requests: bool`, `reconciling: bool`, `bank_onboarding_available:false`.

No cambia las reglas monetarias, la creación de payouts, webhooks ni la migración f20h00000001. Las credenciales y CLABE jamás se devuelven. Si Stripe no confirma el banco, el estado queda `unavailable` y no se autorizan retiros desde Android.

**Pendiente**: QA PostgreSQL clonado + Stripe TEST + verificación API del SDK Stripe actual. En LIVE se exige cuenta Connect aprobada y banco `ba_` fijado. El registro bancario sigue administrado fuera de la app en Stripe Connect/ADMIN: no existe endpoint de onboarding móvil en esta versión. No desplegar sin QA y backups; no habilitar Stripe LIVE sin conciliación.
