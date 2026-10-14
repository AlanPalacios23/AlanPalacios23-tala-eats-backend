from datetime import datetime
from decimal import Decimal
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)

class DriverProfilePublic(ORMModel):
    vehicle: str; plate: str; is_online: bool; is_verified: bool; rating: Decimal; total_deliveries: int
    current_lat: float | None; current_lng: float | None; earnings_today: Decimal = Decimal("0.00")

class UserPublic(ORMModel):
    id: int; name: str; email: EmailStr; role: str; auth_provider: str; avatar_url: str | None; phone: str; is_active: bool; two_factor_enabled: bool=False; marketing_opt_in: bool=True; analytics_opt_in: bool=True; personalization_opt_in: bool=True; birth_date:str=""

class RegisterRequest(BaseModel):
    name: str = Field(min_length=2, max_length=120); email: EmailStr; password: str = Field(min_length=8, max_length=128)
class LoginRequest(BaseModel): email: EmailStr; password: str; otp: str = Field(default="", max_length=12)
class GoogleAuthRequest(BaseModel): credential: str = Field(min_length=20)
class AuthResponse(BaseModel): access_token: str; token_type: str = "bearer"; user: UserPublic; device_token: str = ""
class ProfileUpdate(BaseModel):
    name: str|None = Field(default=None,min_length=2,max_length=120)
    phone: str|None = Field(default=None,max_length=30)
    avatar_url: str|None = Field(default=None,max_length=600)
    birth_date: str|None = Field(default=None,max_length=10)
class PasswordForgotRequest(BaseModel): email: EmailStr
class PasswordResetConfirm(BaseModel): token: str = Field(min_length=20,max_length=300); password: str = Field(min_length=8,max_length=128)

class MenuItemPublic(ORMModel):
    id: int; restaurant_id: int; name: str; description: str; category: str; price: Decimal; is_available: bool
    stock: int = 100; dietary_tags: str = ""; allergens: str = ""; is_combo: bool = False; options_json: str = "[]"; availability_schedule_json:str="{}"; price_schedule_json:str="{}"; image_url: str = ""
class MenuItemCreate(BaseModel):
    name: str = Field(min_length=2,max_length=150); description: str=""; category: str="General"; price: Decimal=Field(gt=0); is_available: bool=True
    stock: int=Field(default=100,ge=0); dietary_tags: str=""; allergens: str=""; is_combo: bool=False; options_json: str="[]"; availability_schedule_json:str="{}"; price_schedule_json:str="{}"
class MenuItemUpdate(BaseModel):
    name: str|None=Field(default=None,min_length=2,max_length=150); description: str|None=None; category: str|None=None; price: Decimal|None=Field(default=None,gt=0)
    is_available: bool|None=None; stock: int|None=Field(default=None,ge=0); dietary_tags: str|None=None; allergens: str|None=None; is_combo: bool|None=None; options_json: str|None=None; availability_schedule_json:str|None=None; price_schedule_json:str|None=None

class RestaurantPublic(ORMModel):
    id:int; name:str; description:str; cuisine:str; emoji:str; eta_min:int; delivery_fee:Decimal; is_open:bool; owner_id:int|None
    lat:float=20.6534; lng:float=-103.704; address:str=""; delivery_radius_km:float=8.0; per_km_fee:Decimal=Decimal("4.00"); pickup_enabled:bool=True; sponsored:bool=False; rating:Decimal=Decimal("4.80"); verification_status:str="verified"
    commercial_plan:str="START"; commission_rate:Decimal=Decimal("0.1200"); service_fee_rate:Decimal=Decimal("0.0400"); service_fee_fixed:Decimal=Decimal("0.00"); branch_code:str="MAIN"; brand_name:str=""; market_code:str="TALA-JAL"; onboarding_status:str="approved"; cover_image_url:str=""
class RestaurantDetail(RestaurantPublic): menu_items:list[MenuItemPublic]=Field(default_factory=list)
class RestaurantCreate(BaseModel):
    name:str=Field(min_length=2,max_length=150); description:str=""; cuisine:str="Comida local"; emoji:str="🍽️"; eta_min:int=Field(default=30,ge=5,le=180)
    delivery_fee:Decimal=Field(default=Decimal("0"),ge=0); is_open:bool=True; owner_email:EmailStr|None=None
    lat:float=Field(default=20.6534,ge=-90,le=90,allow_inf_nan=False)
    lng:float=Field(default=-103.704,ge=-180,le=180,allow_inf_nan=False)
    address:str=Field(default="",max_length=300)
    delivery_radius_km:float=8.0; per_km_fee:Decimal=Decimal("4.00"); pickup_enabled:bool=True; sponsored:bool=False

class RestaurantUpdate(BaseModel):
    name:str|None=None; description:str|None=None; cuisine:str|None=None; emoji:str|None=None
    eta_min:int|None=Field(default=None,ge=5,le=180); delivery_fee:Decimal|None=Field(default=None,ge=0)
    is_open:bool|None=None; delivery_radius_km:float|None=None; per_km_fee:Decimal|None=Field(default=None,ge=0)
    pickup_enabled:bool|None=None; sponsored:bool|None=None; pos_webhook_url:str|None=None; tax_id:str|None=None
    # Exact canonical fields used by the restaurant Android profile.
    address:str|None=Field(default=None,min_length=5,max_length=300)
    lat:float|None=Field(default=None,ge=-90,le=90,allow_inf_nan=False)
    lng:float|None=Field(default=None,ge=-180,le=180,allow_inf_nan=False)

    @model_validator(mode="after")
    def validate_location(self):
        fields=self.model_fields_set
        has_lat="lat" in fields
        has_lng="lng" in fields
        if has_lat != has_lng or (has_lat and (self.lat is None or self.lng is None)):
            raise ValueError("lat y lng deben enviarse juntos como coordenadas válidas")
        if "address" in fields and (self.address is None or not self.address.strip()):
            raise ValueError("La dirección del restaurante no puede estar vacía")
        if self.address is not None:
            self.address=self.address.strip()
        return self

class OrderItemCreate(BaseModel):
    menu_item_id:int; quantity:int=Field(ge=1,le=50); options:str=""
class OrderCreate(BaseModel):
    restaurant_id:int; address:str=Field(min_length=3,max_length=300); notes:str=Field(default="",max_length=1000)
    payment_method:str=Field(default="mercadopago",pattern="^(mercadopago|stripe|cash|wallet|gift_card|corporate)$"); tip:Decimal=Field(default=Decimal("0"),ge=0,le=10000); items:list[OrderItemCreate]=Field(min_length=1,max_length=100)
    order_type:str=Field(default="delivery",pattern="^(delivery|pickup)$"); scheduled_for:datetime|None=None; coupon_code:str=""; group_code:str=""; distance_km:float=Field(default=2.5,ge=0,le=100)
    invoice_requested:bool=False; invoice_tax_id:str=""; gift_card_code:str=""; delivery_lat:float|None=Field(default=None,ge=-90,le=90); delivery_lng:float|None=Field(default=None,ge=-180,le=180); client_reference:str|None=Field(default=None,max_length=80); recipient_name:str=Field(default="",max_length=120); recipient_phone:str=Field(default="",max_length=40); gift_message:str=Field(default="",max_length=300); corporate_account_id:int|None=None
class OrderItemPublic(ORMModel): id:int; menu_item_id:int|None; name_snapshot:str; quantity:int; unit_price:Decimal; options_snapshot:str=""
class DriverSummary(BaseModel):
    id:int; name:str; phone:str; avatar_url:str|None=None; vehicle:str="Motocicleta"; rating:Decimal=Decimal("5"); current_lat:float|None=None; current_lng:float|None=None
class OrderOperationalPublic(ORMModel):
    id:int; user_id:int; restaurant_id:int; driver_id:int|None; status:str; payment_method:str; payment_status:str; subtotal:Decimal; delivery_fee:Decimal; discount:Decimal; tip:Decimal; total:Decimal
    platform_commission:Decimal=Decimal("0"); service_fee:Decimal=Decimal("0"); payment_processing_fee:Decimal=Decimal("0"); refunded_amount:Decimal=Decimal("0"); promotion_subsidy:Decimal=Decimal("0"); platform_revenue:Decimal=Decimal("0"); contribution_margin:Decimal=Decimal("0"); cash_collected:Decimal=Decimal("0"); cancellation_fee:Decimal=Decimal("0"); restaurant_payout:Decimal=Decimal("0"); driver_earning:Decimal=Decimal("0"); payment_provider:str=""; payment_provider_id:str=""; payment_preference_id:str=""; address:str; notes:str; order_type:str="delivery"
    scheduled_for:datetime|None=None; coupon_code:str=""; group_code:str=""; recipient_name:str=""; recipient_phone:str=""; gift_message:str=""; corporate_account_id:int|None=None; distance_km:float=0; delivery_lat:float|None=None; delivery_lng:float|None=None; estimated_minutes:int=30; invoice_requested:bool=False; invoice_tax_id:str=""; client_reference:str|None=None; created_at:datetime; updated_at:datetime
    accepted_at:datetime|None=None; preparing_at:datetime|None=None; ready_at:datetime|None=None; picked_up_at:datetime|None=None; delivered_at:datetime|None=None
    items:list[OrderItemPublic]=Field(default_factory=list); driver_info:DriverSummary|None=None

class OrderPublic(OrderOperationalPublic):
    # Secret delivery proof: only customer-facing order endpoints serialize it.
    delivery_pin:str
class OrderStatusUpdate(BaseModel): status:str
class DriverAvailabilityUpdate(BaseModel): is_online:bool
class DriverLocationUpdate(BaseModel): lat:float=Field(ge=-90,le=90); lng:float=Field(ge=-180,le=180)
class DeliveryCompleteRequest(BaseModel): pin:str=Field(pattern=r"^\d{4}$"); photo_url:str=""; lat:float|None=None; lng:float|None=None

class AddressPublic(ORMModel): id:int; label:str; address:str; lat:float|None; lng:float|None; is_default:bool
class AddressCreate(BaseModel): label:str="Casa"; address:str=Field(min_length=5,max_length=300); lat:float|None=None; lng:float|None=None; is_default:bool=False
class AddressUpdate(BaseModel):
    label:str|None=Field(default=None,max_length=60)
    address:str|None=Field(default=None,min_length=5,max_length=300)
    lat:float|None=None; lng:float|None=None; is_default:bool|None=None
class CouponPublic(ORMModel): code:str; discount_type:str; value:Decimal; min_order:Decimal; active:bool; description:str
class PromotionPublic(ORMModel): id:int; restaurant_id:int|None; title:str; description:str; discount_percent:int; active:bool; sponsored:bool
class ReviewCreate(BaseModel): order_id:int; restaurant_rating:int=Field(ge=1,le=5); driver_rating:int|None=Field(default=None,ge=1,le=5); comment:str=Field(default="",max_length=1000)
class ReviewPublic(ORMModel): id:int; order_id:int; restaurant_id:int; restaurant_rating:int; driver_rating:int|None; comment:str; created_at:datetime
class NotificationPublic(ORMModel): id:int; kind:str; title:str; message:str; is_read:bool; created_at:datetime
class ChatCreate(BaseModel): message:str=Field(default="",max_length=1000); message_type:str=Field(default="text",pattern="^(text|photo|location|quick)$"); media_url:str=Field(default="",max_length=600); lat:float|None=None; lng:float|None=None
class ChatPublic(ORMModel): id:int; order_id:int; sender_id:int; message:str; message_type:str="text"; media_url:str=""; lat:float|None=None; lng:float|None=None; created_at:datetime
class LoyaltyPublic(ORMModel): points:int; tier:str="BRONZE"; streak_days:int=0; plus_savings:Decimal=Decimal("0.00"); wallet_balance:Decimal; plus_member:bool; referral_code:str
class GiftRedeem(BaseModel): code:str
class WalletTransactionPublic(ORMModel):
    id:int; kind:str; amount:Decimal; balance_after:Decimal; reference_type:str=""; reference_id:str=""; description:str=""; created_at:datetime
class WalletSummary(BaseModel):
    balance:Decimal; points:int; plus_member:bool; referral_code:str; transactions:list[WalletTransactionPublic]=Field(default_factory=list)
class WalletAdminAdjustment(BaseModel):
    amount: Decimal
    reason: str = Field(min_length=3, max_length=300)

    @field_validator("amount")
    @classmethod
    def amount_must_not_be_zero(cls, value: Decimal) -> Decimal:
        if value == 0:
            raise ValueError("El ajuste no puede ser 0")
        return value
class SupportCreate(BaseModel): order_id:int|None=None; category:str; message:str=Field(min_length=5,max_length=3000)
class SupportPublic(ORMModel): id:int; order_id:int|None; category:str; message:str; status:str; created_at:datetime
class FeatureItem(BaseModel): id:int; name:str; area:str; mode:str; description:str
class PlatformOverview(BaseModel): version:str; feature_count:int; features:list[FeatureItem]
class AdminStats(BaseModel):
    users:int; customers:int; restaurants:int; drivers:int; online_drivers:int; menu_items:int; orders:int; active_orders:int; gross_sales:Decimal
    commissions:Decimal=Decimal("0"); support_open:int=0; fraud_flags:int=0; plus_members:int=0

class OnboardingCreate(BaseModel):
    entity_type: str = Field(pattern="^(restaurant|driver)$")
    business_name: str = Field(default="", max_length=160)
    tax_id: str = Field(default="", max_length=60)
    vehicle: str = Field(default="", max_length=100)
    payout_account_ref: str = Field(default="", max_length=180)
    documents: list[str] = Field(default_factory=list)

class OnboardingPublic(ORMModel):
    id:int; user_id:int; entity_type:str; business_name:str; tax_id:str; vehicle:str; payout_account_ref:str; status:str; notes:str; created_at:datetime; updated_at:datetime

class OnboardingDecision(BaseModel):
    status: str = Field(pattern="^(approved|rejected|needs_info|suspended)$")
    notes: str = Field(default="", max_length=2000)

class ServiceZoneCreate(BaseModel):
    name:str=Field(min_length=2,max_length=120); center_lat:float=Field(ge=-90,le=90); center_lng:float=Field(ge=-180,le=180); radius_km:float=Field(gt=0,le=150); surcharge:Decimal=Field(default=Decimal("0"),ge=0); min_order:Decimal=Field(default=Decimal("0"),ge=0); active:bool=True
class ServiceZonePublic(ORMModel):
    id:int; name:str; center_lat:float; center_lng:float; radius_km:float; surcharge:Decimal; min_order:Decimal; active:bool

class DisputeCreate(BaseModel):
    order_id:int; category:str=Field(min_length=3,max_length=80); description:str=Field(min_length=5,max_length=3000)
class DisputeResolve(BaseModel):
    status:str=Field(pattern="^(resolved|rejected|needs_info)$"); resolution:str=Field(min_length=3,max_length=3000); refund_amount:Decimal=Field(default=Decimal("0"),ge=0)
class DisputePublic(ORMModel):
    id:int; order_id:int; opened_by_user_id:int; category:str; description:str; status:str; resolution:str; refund_amount:Decimal; assigned_to_user_id:int|None; created_at:datetime; resolved_at:datetime|None

class FeatureFlagWrite(BaseModel):
    key:str=Field(min_length=2,max_length=100,pattern=r"^[a-z0-9_.-]+$"); description:str=Field(default="",max_length=300); enabled:bool=False; rollout_percent:int=Field(default=100,ge=0,le=100); audience_role:str=Field(default="all",pattern="^(all|customer|restaurant|driver|admin)$")
class FeatureFlagPublic(ORMModel):
    id:int; key:str; description:str; enabled:bool; rollout_percent:int; audience_role:str; updated_at:datetime

class SettingWrite(BaseModel):
    key:str=Field(min_length=2,max_length=100,pattern=r"^[a-z0-9_.-]+$"); value:str=Field(max_length=500); value_type:str=Field(default="string",pattern="^(string|decimal|integer|boolean)$"); description:str=Field(default="",max_length=300)
class SettingPublic(ORMModel):
    id:int; key:str; value:str; value_type:str; description:str; updated_by_user_id:int|None; updated_at:datetime

class PayoutPublic(ORMModel):
    id:int; payee_type:str; payee_id:int; amount:Decimal; currency:str; period_start:datetime; period_end:datetime; status:str; provider_ref:str; created_at:datetime; paid_at:datetime|None
class CashSettlementPublic(ORMModel):
    id:int; driver_id:int; period_label:str; cash_collected:Decimal; driver_earnings:Decimal; amount_due_platform:Decimal; status:str; notes:str; created_at:datetime; settled_at:datetime|None

class SponsoredCampaignCreate(BaseModel):
    restaurant_id:int; name:str=Field(min_length=2,max_length=150); daily_budget:Decimal=Field(gt=0,le=100000); active:bool=True
class SponsoredCampaignPublic(ORMModel):
    id:int; restaurant_id:int; name:str; daily_budget:Decimal; spent:Decimal; impressions:int; clicks:int; attributed_orders:int; active:bool; starts_at:datetime; ends_at:datetime|None

class SimulationCreate(BaseModel):
    scenario:str=Field(default="happy_path",pattern="^(happy_path|cash_delivery|cancel_before_prep|no_driver)$")
class SimulationPublic(ORMModel):
    id:int; created_by_user_id:int; scenario:str; status:str; current_step:str; state_json:str; created_at:datetime; updated_at:datetime

class CommercialConfigUpdate(BaseModel):
    commercial_plan:str|None=Field(default=None,pattern="^(START|DELIVERY|PRO)$")
    commission_rate:Decimal|None=Field(default=None,ge=0,le=Decimal("0.50"))
    service_fee_rate:Decimal|None=Field(default=None,ge=0,le=Decimal("0.25"))
    service_fee_fixed:Decimal|None=Field(default=None,ge=0,le=1000)
    payout_account_ref:str|None=Field(default=None,max_length=180)

class PlusSubscribeRequest(BaseModel):
    plan:str=Field(default="PLUS",pattern="^(PLUS|PLUS_FAMILY)$")

# ---------------------------------------------------------------------------
# V9 schemas
# ---------------------------------------------------------------------------
class ProductEventCreate(BaseModel):
    event_name:str=Field(min_length=2,max_length=100); session_id:str=Field(default="",max_length=80); route:str=Field(default="",max_length=240); properties:dict={}
class ExperimentCreate(BaseModel):
    key:str=Field(pattern=r"^[a-z0-9_.-]+$",min_length=2,max_length=100); name:str=Field(min_length=2,max_length=180); variants:list[str]=Field(default_factory=lambda:["control","variant"]); audience_role:str=Field(default="customer",pattern="^(all|customer|restaurant|driver|admin)$"); rollout_percent:int=Field(default=100,ge=0,le=100); primary_metric:str="checkout_completed"; status:str=Field(default="running",pattern="^(draft|running|paused|completed)$")
class DriverIncentiveCreate(BaseModel):
    zone_name:str="General"; title:str=Field(min_length=2,max_length=180); bonus_per_delivery:Decimal=Field(default=Decimal("0"),ge=0); multiplier:Decimal=Field(default=Decimal("1"),ge=1,le=5); starts_at:datetime|None=None; ends_at:datetime|None=None
class MarketingAutomationCreate(BaseModel):
    name:str=Field(min_length=2,max_length=180); trigger_type:str=Field(pattern="^(inactive_7d|inactive_30d|birthday|cart_abandoned|first_order|vip|at_risk)$"); segment:str="all"; channel:str=Field(default="in_app",pattern="^(in_app|email)$"); coupon_code:str=""; message_template:str=Field(min_length=3,max_length=1000); active:bool=True
class IngredientCreate(BaseModel):
    name:str=Field(min_length=2,max_length=140); unit:str="unit"; quantity:Decimal=Field(default=Decimal("0"),ge=0); reorder_level:Decimal=Field(default=Decimal("0"),ge=0); unit_cost:Decimal=Field(default=Decimal("0"),ge=0)
class IngredientAdjust(BaseModel): quantity_delta:Decimal; reason:str=Field(default="adjustment",max_length=180)
class RecipeComponentCreate(BaseModel): menu_item_id:int; ingredient_id:int; quantity_required:Decimal=Field(gt=0)
class WasteCreate(BaseModel): ingredient_id:int|None=None; quantity:Decimal=Field(gt=0); reason:str=Field(min_length=2,max_length=180)
class CorporateCreate(BaseModel): name:str=Field(min_length=2,max_length=180); monthly_budget:Decimal=Field(default=Decimal("0"),ge=0); cost_center:str="GENERAL"
class CorporateJoin(BaseModel): join_code:str=Field(min_length=4,max_length=30); employee_code:str=Field(default="",max_length=80)
class PrivacyRequestCreate(BaseModel): request_type:str=Field(pattern="^(export|delete|marketing_opt_out)$")
class IncidentResolve(BaseModel): status:str=Field(default="resolved",pattern="^(resolved|dismissed)$"); note:str=Field(default="",max_length=500)
class PartnerKeyCreate(BaseModel): partner_name:str=Field(min_length=2,max_length=180); scopes:str=Field(default="catalog:read,orders:read",max_length=500)
class TwoFactorVerify(BaseModel): code:str=Field(pattern=r"^\d{6}$")

class GroupCartCreate(BaseModel): restaurant_id:int
class GroupCartItemWrite(BaseModel): menu_item_id:int; quantity:int=Field(default=1,ge=1,le=20); options:str=Field(default="",max_length=500)

# ---------------------------------------------------------------------------
# V11 launch-ready schemas
# ---------------------------------------------------------------------------
class PushSubscriptionWrite(BaseModel):
    endpoint:str=Field(min_length=20,max_length=1200)
    p256dh:str=Field(default="",max_length=300)
    auth:str=Field(default="",max_length=300)
    platform:str=Field(default="web",pattern="^(web|android|ios)$")
    device_label:str=Field(default="",max_length=200)

class PushSubscriptionPublic(ORMModel):
    id:int; platform:str; device_label:str; active:bool; created_at:datetime; updated_at:datetime

class PartialRefundRequest(BaseModel):
    amount:Decimal=Field(gt=0)
    reason:str=Field(min_length=3,max_length=300)
    idempotency_key:str=Field(min_length=8,max_length=180)

class RefundAdjustmentPublic(ORMModel):
    id:int; order_id:int; created_by_user_id:int|None; amount:Decimal; reason:str; provider:str; provider_ref:str; status:str; idempotency_key:str; created_at:datetime; completed_at:datetime|None

class SubstitutionCreate(BaseModel):
    order_item_id:int
    replacement_menu_item_id:int|None=None
    issue_type:str=Field(default="unavailable",pattern="^(unavailable|quality|quantity|other)$")
    message:str=Field(default="",max_length=500)

class SubstitutionResolve(BaseModel):
    action:str=Field(pattern="^(accept|remove_item|cancel_order|reject)$")

class SubstitutionPublic(ORMModel):
    id:int; order_id:int; order_item_id:int; restaurant_id:int; requested_by_user_id:int; replacement_menu_item_id:int|None; issue_type:str; message:str; original_amount:Decimal; replacement_amount:Decimal; status:str; resolution:str; created_at:datetime; expires_at:datetime|None; resolved_at:datetime|None

class DriverOfferPublic(ORMModel):
    id:int; order_id:int; driver_id:int; round_no:int; status:str; score:float; estimated_pickup_min:int; estimated_earning:Decimal; offered_at:datetime; expires_at:datetime; responded_at:datetime|None

class DriverOfferResponse(BaseModel):
    action:str=Field(pattern="^(accept|reject)$")

class PayoutDispatchRequest(BaseModel):
    payout_ids:list[int]=Field(min_length=1,max_length=100)

class GeocodeRequest(BaseModel):
    query:str=Field(min_length=3,max_length=300)
    limit:int=Field(default=5,ge=1,le=10)

class RouteEstimateRequest(BaseModel):
    origin_lat:float=Field(ge=-90,le=90); origin_lng:float=Field(ge=-180,le=180)
    destination_lat:float=Field(ge=-90,le=90); destination_lng:float=Field(ge=-180,le=180)

class KdsBumpRequest(BaseModel):
    action:str=Field(pattern="^(confirm|start|ready|undo)$")
    station:str=Field(default="general",max_length=60)

class PrivacyPreferencesWrite(BaseModel):
    marketing_opt_in:bool|None=None
    analytics_opt_in:bool|None=None
    personalization_opt_in:bool|None=None

class CanaryWrite(BaseModel):
    percent:int=Field(ge=0,le=100)

class IntegrationWebhookAck(BaseModel):
    received:bool=True
    duplicate:bool=False
