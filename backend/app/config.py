import os
from pathlib import Path


def _bool(name: str, default: bool = False) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


def _csv(name: str, default: str = "") -> list[str]:
    return [x.strip() for x in os.getenv(name, default).split(",") if x.strip()]


def _int(name: str, default: int, *, minimum: int | None = None, maximum: int | None = None) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        value = default
    if minimum is not None:
        value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


class Settings:
    app_name = "Tala Eats API"
    app_version = "1.6.4-connect-selfservice-hf1"
    hardening_revision = "core-resilience-v1"
    environment = os.getenv("ENVIRONMENT", "development").strip().lower()
    debug = _bool("DEBUG", environment != "production")

    database_url = os.getenv("DATABASE_URL", "sqlite:///./talaeats_v3.db")
    db_pool_size = _int("DB_POOL_SIZE", 8, minimum=1, maximum=100)
    db_max_overflow = _int("DB_MAX_OVERFLOW", 4, minimum=0, maximum=100)
    db_pool_timeout = _int("DB_POOL_TIMEOUT", 8, minimum=1, maximum=120)
    db_pool_recycle = _int("DB_POOL_RECYCLE", 900, minimum=60, maximum=86400)
    db_statement_timeout_ms = _int("DB_STATEMENT_TIMEOUT_MS", 12000, minimum=1000, maximum=120000)
    db_lock_timeout_ms = _int("DB_LOCK_TIMEOUT_MS", 3000, minimum=250, maximum=30000)
    db_idle_tx_timeout_ms = _int("DB_IDLE_TX_TIMEOUT_MS", 15000, minimum=1000, maximum=120000)
    redis_max_connections = _int("REDIS_MAX_CONNECTIONS", 100, minimum=10, maximum=1000)
    redis_socket_timeout_seconds = _int("REDIS_SOCKET_TIMEOUT_SECONDS", 2, minimum=1, maximum=30)
    driver_location_db_interval_seconds = _int("DRIVER_LOCATION_DB_INTERVAL_SECONDS", 5, minimum=1, maximum=60)
    redis_url = os.getenv("REDIS_URL", "").strip()

    jwt_secret = os.getenv("JWT_SECRET", "CHANGE_ME_IN_PRODUCTION")
    jwt_algorithm = "HS256"
    access_token_minutes = _int("ACCESS_TOKEN_MINUTES", 480, minimum=5, maximum=43200)
    jwt_leeway_seconds = _int("JWT_LEEWAY_SECONDS", 15, minimum=0, maximum=120)
    session_cookie_name = os.getenv("SESSION_COOKIE_NAME", "talaeats_session")
    cookie_secure = _bool("COOKIE_SECURE", environment == "production")

    cors_origins = _csv("CORS_ORIGINS", "http://localhost:5173,http://localhost")
    allowed_hosts = _csv("ALLOWED_HOSTS", "localhost,127.0.0.1,testserver")
    public_base_url = os.getenv("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/")
    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5173").rstrip("/")
    trust_proxy_headers = _bool("TRUST_PROXY_HEADERS", environment == "production")

    google_client_id = os.getenv("GOOGLE_CLIENT_ID", "").strip()

    smtp_host = os.getenv("SMTP_HOST", "").strip()
    smtp_port = _int("SMTP_PORT", 587, minimum=1, maximum=65535)
    smtp_username = os.getenv("SMTP_USERNAME", "").strip()
    smtp_password = os.getenv("SMTP_PASSWORD", "").strip()
    smtp_from_email = os.getenv("SMTP_FROM_EMAIL", "noreply@talaeats.mx").strip()
    smtp_from_name = os.getenv("SMTP_FROM_NAME", "Tala Eats").strip()
    smtp_use_tls = _bool("SMTP_USE_TLS", True)
    smtp_use_ssl = _bool("SMTP_USE_SSL", False)
    support_email = os.getenv("SUPPORT_EMAIL", "soporte@talaeats.mx").strip()
    password_reset_minutes = _int("PASSWORD_RESET_MINUTES", 30, minimum=5, maximum=1440)
    require_online_payments = _bool("REQUIRE_ONLINE_PAYMENTS", False)
    # Opt-in override: preserve existing production policy unless explicitly enabled.
    # Even when permitted, cash never incurs a customer service fee.
    cash_checkout_enabled = _bool("CASH_CHECKOUT_ENABLED", False)
    # Independent Finance V2, shadow-only: never authorizes payouts or money movement.
    finance_v2_shadow_enabled = _bool("FINANCE_V2_SHADOW_ENABLED", False)
    # Versioned commercial rules, opt-out for safe rollback with legacy behavior.
    commercial_pricing_v152_enabled = _bool("COMMERCIAL_PRICING_V152_ENABLED", True)
    # Opt-in until staged QA passes; preserves v1.6.1 pricing if omitted.
    commercial_pricing_v162_enabled = _bool("COMMERCIAL_PRICING_V162_ENABLED", False)
    require_smtp = _bool("REQUIRE_SMTP", False)
    payment_provider = os.getenv("PAYMENT_PROVIDER", "mercadopago").strip().lower()
    # Stripe is additive; existing Mercado Pago and cash checkouts are preserved.
    stripe_enabled = _bool("STRIPE_ENABLED", False)
    stripe_secret_key = os.getenv("STRIPE_SECRET_KEY", "").strip()
    stripe_publishable_key = os.getenv("STRIPE_PUBLISHABLE_KEY", "").strip()
    stripe_webhook_secret = os.getenv("STRIPE_WEBHOOK_SECRET", "").strip()
    stripe_connect_enabled = _bool("STRIPE_CONNECT_ENABLED", False)
    # Standalone Connect registration, separate from money movement (OFF unless deliberately enabled).
    stripe_connect_self_service_enabled = _bool("STRIPE_CONNECT_SELF_SERVICE_ENABLED", False)
    # v1.6.3: Both toggles OFF until accounting/Stripe LIVE reconciliation is approved.
    withdrawals_preview_enabled = _bool("WITHDRAWALS_PREVIEW_ENABLED", False)
    withdrawals_execution_enabled = _bool("WITHDRAWALS_EXECUTION_ENABLED", False)
    withdrawals_min_age_days = _int("WITHDRAWALS_HOLD_DAYS", 7, minimum=1, maximum=90)
    stripe_connect_webhook_secret = os.getenv("STRIPE_CONNECT_WEBHOOK_SECRET", "").strip()
    # A second, deliberate LIVE-only authorization is required even if the generic
    # execution flag is accidentally enabled in production.
    withdrawals_live_enabled = _bool("WITHDRAWALS_LIVE_ENABLED", False)
    withdrawals_approved_accounts = _csv("WITHDRAWALS_APPROVED_ACCOUNTS", "")
    # LIVE bank routing allowlist: acct_...:ba_..., deliberately exact and non-secret.
    withdrawals_approved_bank_destinations = _csv("WITHDRAWALS_APPROVED_BANK_DESTINATIONS", "")
    withdrawals_max_request_cents = _int("WITHDRAWALS_MAX_REQUEST_CENTS", 50000, minimum=100, maximum=10000000)
    withdrawals_max_daily_cents = _int("WITHDRAWALS_MAX_DAILY_CENTS", 100000, minimum=100, maximum=10000000)

    stripe_apple_merchant_id = os.getenv("STRIPE_APPLE_MERCHANT_ID", "").strip()
    stripe_service_fee_rate = os.getenv("STRIPE_SERVICE_FEE_RATE", "0.0400").strip()
    stripe_service_fee_fixed = os.getenv("STRIPE_SERVICE_FEE_FIXED", "3.00").strip()
    stripe_processing_rate = os.getenv("STRIPE_PROCESSING_RATE", "0.0360").strip()
    stripe_processing_fixed = os.getenv("STRIPE_PROCESSING_FIXED", "3.00").strip()
    stripe_processing_tax_rate = os.getenv("STRIPE_PROCESSING_TAX_RATE", "0.16").strip()
    stripe_max_event_age = _int("STRIPE_WEBHOOK_TOLERANCE_SECONDS", 300, minimum=60, maximum=900)
    mercado_pago_access_token = os.getenv("MERCADO_PAGO_ACCESS_TOKEN", "").strip()
    mercado_pago_webhook_secret = os.getenv("MERCADO_PAGO_WEBHOOK_SECRET", "").strip()
    mercado_pago_public_key = os.getenv("MERCADO_PAGO_PUBLIC_KEY", "").strip()
    mercado_pago_marketplace_fee_enabled = _bool("MERCADO_PAGO_MARKETPLACE_FEE_ENABLED", False)

    maps_provider = os.getenv("MAPS_PROVIDER", "openstreetmap").strip().lower()
    ai_provider = os.getenv("AI_PROVIDER", "rules").strip().lower()

    media_dir = Path(os.getenv("MEDIA_DIR", "./media")).resolve()
    max_upload_mb = _int("MAX_UPLOAD_MB", 8, minimum=1, maximum=50)
    max_request_body_mb = _int("MAX_REQUEST_BODY_MB", 12, minimum=1, maximum=64)
    max_order_items = _int("MAX_ORDER_ITEMS", 100, minimum=1, maximum=500)
    default_page_size = _int("DEFAULT_PAGE_SIZE", 100, minimum=10, maximum=200)
    max_page_size = _int("MAX_PAGE_SIZE", 200, minimum=50, maximum=500)
    payment_reservation_minutes = _int("PAYMENT_RESERVATION_MINUTES", 30, minimum=5, maximum=240)
    schedule_prep_lead_minutes = _int("SCHEDULE_PREP_LEAD_MINUTES", 45, minimum=5, maximum=360)
    rate_limit_per_minute = _int("RATE_LIMIT_PER_MINUTE", 600, minimum=30, maximum=10000)
    rate_limit_auth_per_minute = _int("RATE_LIMIT_AUTH_PER_MINUTE", 20, minimum=5, maximum=1000)
    rate_limit_mutation_per_minute = _int("RATE_LIMIT_MUTATION_PER_MINUTE", 240, minimum=20, maximum=5000)
    rate_limit_upload_per_minute = _int("RATE_LIMIT_UPLOAD_PER_MINUTE", 30, minimum=5, maximum=500)
    slow_request_ms = _int("SLOW_REQUEST_MS", 1000, minimum=100, maximum=60000)
    health_cache_seconds = _int("HEALTH_CACHE_SECONDS", 2, minimum=0, maximum=30)

    # V11 launch / integrations
    native_push_enabled = _bool("NATIVE_PUSH_ENABLED", False)
    fcm_project_id = os.getenv("FCM_PROJECT_ID", "").strip()
    fcm_credentials_file = os.getenv("FCM_CREDENTIALS_FILE", "").strip()
    fcm_token_encryption_key = os.getenv("FCM_TOKEN_ENCRYPTION_KEY", "").strip()
    native_push_batch_size = _int("NATIVE_PUSH_BATCH_SIZE", 25, minimum=1, maximum=100)
    native_push_max_attempts = _int("NATIVE_PUSH_MAX_ATTEMPTS", 6, minimum=1, maximum=12)
    native_push_http_timeout = _int("NATIVE_PUSH_HTTP_TIMEOUT", 10, minimum=3, maximum=30)
    web_push_vapid_public_key = os.getenv("WEB_PUSH_VAPID_PUBLIC_KEY", "").strip()
    web_push_vapid_private_key = os.getenv("WEB_PUSH_VAPID_PRIVATE_KEY", "").strip()
    web_push_subject = os.getenv("WEB_PUSH_SUBJECT", "mailto:soporte@talaeats.mx").strip()
    maps_api_key = os.getenv("MAPS_API_KEY", "").strip()
    maps_geocode_url = os.getenv("MAPS_GEOCODE_URL", "").strip()
    maps_directions_url = os.getenv("MAPS_DIRECTIONS_URL", "").strip()
    payout_provider = os.getenv("PAYOUT_PROVIDER", "manual").strip().lower()
    payout_api_url = os.getenv("PAYOUT_API_URL", "").strip()
    payout_api_token = os.getenv("PAYOUT_API_TOKEN", "").strip()
    payout_webhook_secret = os.getenv("PAYOUT_WEBHOOK_SECRET", "").strip()
    require_payout_provider = _bool("REQUIRE_PAYOUT_PROVIDER", False)
    require_privileged_2fa = _bool("REQUIRE_PRIVILEGED_2FA", environment == "production")
    privileged_2fa_grace_minutes = _int("PRIVILEGED_2FA_GRACE_MINUTES", 30, minimum=1, maximum=1440)
    canary_percent = max(0, min(100, _int("CANARY_PERCENT", 0)))
    release_channel = os.getenv("RELEASE_CHANNEL", "stable").strip().lower()
    otel_endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip()
    otel_service_name = os.getenv("OTEL_SERVICE_NAME", "talaeats-api").strip()
    backup_retention_days = _int("BACKUP_RETENTION_DAYS", 14, minimum=1, maximum=365)
    order_offer_seconds = _int("DRIVER_OFFER_SECONDS", 30, minimum=10, maximum=300)
    driver_offer_mode = _bool("DRIVER_OFFER_MODE", False)
    merchant_managed_delivery = _bool("MERCHANT_MANAGED_DELIVERY", False)
    substitution_response_minutes = _int("SUBSTITUTION_RESPONSE_MINUTES", 8, minimum=1, maximum=120)
    max_partial_refund_percent = _int("MAX_PARTIAL_REFUND_PERCENT", 100, minimum=1, maximum=100)
    public_api_version = os.getenv("PUBLIC_API_VERSION", "v1").strip()
    wallet_max_balance = _int("WALLET_MAX_BALANCE", 50000, minimum=1000, maximum=10_000_000)
    wallet_max_adjustment = _int("WALLET_MAX_ADJUSTMENT", 10000, minimum=100, maximum=1_000_000)
    seed_demo_data = _bool("SEED_DEMO_DATA", environment != "production")
    docs_enabled = _bool("DOCS_ENABLED", environment != "production")

    # Worker / background safety.
    worker_interval_seconds = _int("WORKER_INTERVAL_SECONDS", 30, minimum=5, maximum=300)
    worker_lock_ttl_seconds = _int("WORKER_LOCK_TTL_SECONDS", 90, minimum=15, maximum=600)
    worker_batch_size = _int("WORKER_BATCH_SIZE", 250, minimum=25, maximum=2000)

    # V1.4 core resilience.
    outbox_batch_size = _int("OUTBOX_BATCH_SIZE", 250, minimum=10, maximum=2000)
    outbox_max_attempts = _int("OUTBOX_MAX_ATTEMPTS", 8, minimum=2, maximum=50)
    outbox_retry_base_seconds = _int("OUTBOX_RETRY_BASE_SECONDS", 5, minimum=1, maximum=300)
    reconciliation_interval_seconds = _int("RECONCILIATION_INTERVAL_SECONDS", 300, minimum=30, maximum=86400)
    reconciliation_lookback_hours = _int("RECONCILIATION_LOOKBACK_HOURS", 72, minimum=1, maximum=720)
    outbox_retention_days = _int("OUTBOX_RETENTION_DAYS", 14, minimum=1, maximum=365)
    reconciliation_retention_days = _int("RECONCILIATION_RETENTION_DAYS", 180, minimum=30, maximum=3650)
    resolved_alert_retention_days = _int("RESOLVED_ALERT_RETENTION_DAYS", 90, minimum=7, maximum=3650)
    alert_error_rate_percent = _int("ALERT_ERROR_RATE_PERCENT", 5, minimum=1, maximum=100)
    alert_p95_ms = _int("ALERT_P95_MS", 1500, minimum=100, maximum=60000)
    alert_outbox_backlog = _int("ALERT_OUTBOX_BACKLOG", 5000, minimum=100, maximum=1000000)
    fraud_velocity_orders_per_hour = _int("FRAUD_VELOCITY_ORDERS_PER_HOUR", 12, minimum=2, maximum=1000)
    fraud_refunds_30d_threshold = _int("FRAUD_REFUNDS_30D_THRESHOLD", 5, minimum=2, maximum=100)
    read_database_url = os.getenv("READ_DATABASE_URL", "").strip()
    postgis_enabled = _bool("POSTGIS_ENABLED", False)
    pitr_enabled = _bool("PITR_ENABLED", False)
    immutable_ledger = _bool("IMMUTABLE_LEDGER", True)
    metrics_admin_only = _bool("METRICS_ADMIN_ONLY", True)
    metrics_window_minutes = _int("METRICS_WINDOW_MINUTES", 5, minimum=1, maximum=15)

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    def validate_production(self) -> None:
        if not self.is_production:
            return
        errors = []
        if self.jwt_secret in {"", "CHANGE_ME_IN_PRODUCTION"} or len(self.jwt_secret) < 40:
            errors.append("JWT_SECRET debe tener al menos 40 caracteres aleatorios")
        if not self.database_url.startswith("postgresql"):
            errors.append("DATABASE_URL debe apuntar a PostgreSQL en producción")
        if not self.redis_url:
            errors.append("REDIS_URL es obligatorio para realtime/rate limiting")
        if not self.allowed_hosts or "*" in self.allowed_hosts:
            errors.append("ALLOWED_HOSTS debe contener dominios explícitos")
        if not self.cors_origins or "*" in self.cors_origins:
            errors.append("CORS_ORIGINS debe contener orígenes explícitos")
        if not self.public_base_url.startswith("https://"):
            errors.append("PUBLIC_BASE_URL debe usar HTTPS")
        if not self.frontend_url.startswith("https://"):
            errors.append("FRONTEND_URL debe usar HTTPS")
        if self.merchant_managed_delivery:
            errors.append("MERCHANT_MANAGED_DELIVERY debe ser false para habilitar Tala Eats Repartidor")
        if self.driver_offer_mode:
            errors.append("DRIVER_OFFER_MODE debe ser false en Tala Eats V1 Producción")
        if self.require_online_payments and self.payment_provider == "mercadopago" and not self.mercado_pago_access_token and not self.stripe_enabled:
            errors.append("MERCADO_PAGO_ACCESS_TOKEN es obligatorio cuando REQUIRE_ONLINE_PAYMENTS=true")
        if self.require_online_payments and self.payment_provider == "mercadopago" and not self.mercado_pago_webhook_secret and not self.stripe_enabled:
            errors.append("MERCADO_PAGO_WEBHOOK_SECRET es obligatorio cuando REQUIRE_ONLINE_PAYMENTS=true")
        if self.stripe_connect_self_service_enabled:
            if not self.stripe_enabled or not self.stripe_secret_key.startswith(("sk_live_", "rk_live_")):
                errors.append("Connect self-service LIVE exige clave Stripe LIVE y STRIPE_ENABLED")
        if self.withdrawals_execution_enabled:
            if not self.withdrawals_preview_enabled or not self.stripe_enabled or not self.stripe_connect_enabled:
                errors.append("Los retiros exigen preview, Stripe y Connect activos")
            if not self.stripe_connect_webhook_secret or len(self.stripe_connect_webhook_secret) < 12:
                errors.append("STRIPE_CONNECT_WEBHOOK_SECRET requerido para retiros")
            if self.stripe_secret_key.startswith(("sk_live_", "rk_live_")):
                if not self.withdrawals_live_enabled:
                    errors.append("WITHDRAWALS_LIVE_ENABLED=true obligatorio para payouts reales")
                if not self.withdrawals_approved_accounts:
                    errors.append("WITHDRAWALS_APPROVED_ACCOUNTS obligatorio para payouts reales")
                from re import fullmatch
                if not self.withdrawals_approved_bank_destinations or any(
                    not fullmatch(r"acct_[A-Za-z0-9]{8,80}:ba_[A-Za-z0-9]{8,100}", pair)
                    for pair in self.withdrawals_approved_bank_destinations
                ):
                    errors.append("WITHDRAWALS_APPROVED_BANK_DESTINATIONS obligatorio y válido para LIVE")
                elif (len(set(x.split(":", 1)[0] for x in self.withdrawals_approved_bank_destinations))
                      != len(self.withdrawals_approved_bank_destinations)):
                    errors.append("Una sola cuenta bancaria aprobada por cuenta Connect")
                elif any(x.split(":", 1)[0] not in self.withdrawals_approved_accounts
                         for x in self.withdrawals_approved_bank_destinations):
                    errors.append("Cuenta bancaria LIVE sin cuenta Connect autorizada")
            if self.withdrawals_max_daily_cents < self.withdrawals_max_request_cents:
                errors.append("Límite diario de retiro no puede ser menor al límite por solicitud")
        if self.stripe_enabled:
            from decimal import Decimal, InvalidOperation
            for label, value in (("STRIPE_SERVICE_FEE_RATE", self.stripe_service_fee_rate),
                                 ("STRIPE_SERVICE_FEE_FIXED", self.stripe_service_fee_fixed),
                                 ("STRIPE_PROCESSING_RATE", self.stripe_processing_rate),
                                 ("STRIPE_PROCESSING_FIXED", self.stripe_processing_fixed),
                                 ("STRIPE_PROCESSING_TAX_RATE", self.stripe_processing_tax_rate)):
                try:
                    number = Decimal(value)
                    if not number.is_finite() or number < 0 or number > 1000:
                        errors.append(f"{label} es inválida")
                except (InvalidOperation, ValueError):
                    errors.append(f"{label} es inválida")
            if not (self.stripe_secret_key and self.stripe_publishable_key and self.stripe_webhook_secret):
                errors.append("Stripe activo exige STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY y STRIPE_WEBHOOK_SECRET")
            elif self.stripe_secret_key.startswith(("sk_live_", "rk_live_")) != self.stripe_publishable_key.startswith("pk_live_"):
                errors.append("Las claves publicable y privada de Stripe deben ser del mismo modo")
        if self.require_online_payments and not (self.mercado_pago_access_token or (self.stripe_enabled and self.stripe_secret_key and self.stripe_webhook_secret)):
            errors.append("REQUIRE_ONLINE_PAYMENTS exige Mercado Pago o Stripe correctamente configurado")
        if self.require_smtp and not self.smtp_host:
            errors.append("SMTP_HOST es obligatorio cuando REQUIRE_SMTP=true")
        if self.require_payout_provider and self.payout_provider == "manual":
            errors.append("PAYOUT_PROVIDER real es obligatorio cuando REQUIRE_PAYOUT_PROVIDER=true")
        if self.payout_provider == "http" and (not self.payout_api_url or not self.payout_api_token):
            errors.append("PAYOUT_API_URL y PAYOUT_API_TOKEN son obligatorios para PAYOUT_PROVIDER=http")
        if self.native_push_enabled and self.is_production and not (
            self.fcm_project_id and self.fcm_credentials_file and self.fcm_token_encryption_key
        ):
            errors.append("NATIVE_PUSH_ENABLED requiere FCM_PROJECT_ID, FCM_CREDENTIALS_FILE y FCM_TOKEN_ENCRYPTION_KEY")
        if self.native_push_enabled:
            import re
            from cryptography.fernet import Fernet
            if not re.fullmatch(r"[a-z0-9][a-z0-9-]{3,80}", self.fcm_project_id):
                errors.append("FCM_PROJECT_ID debe ser un ID de proyecto Firebase valido")
            if not self.fcm_credentials_file or not Path(self.fcm_credentials_file).is_file():
                errors.append("FCM_CREDENTIALS_FILE debe existir y ser legible por el servicio")
            try:
                Fernet(self.fcm_token_encryption_key.encode("ascii"))
            except (ValueError, TypeError, AttributeError):
                errors.append("FCM_TOKEN_ENCRYPTION_KEY debe ser una clave Fernet valida")
        if bool(self.web_push_vapid_public_key) != bool(self.web_push_vapid_private_key):
            errors.append("WEB_PUSH_VAPID_PUBLIC_KEY y WEB_PUSH_VAPID_PRIVATE_KEY deben configurarse juntos")
        if errors:
            raise RuntimeError("Configuración de producción inválida: " + "; ".join(errors))


settings = Settings()
