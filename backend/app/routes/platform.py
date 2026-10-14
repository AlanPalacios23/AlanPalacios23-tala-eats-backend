from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from .. import models, schemas
from ..config import settings
from ..db import get_db
from ..deps import get_current_user, require_role
from ..realtime import publish_order_event
from ..wallet import credit_wallet, get_loyalty_account

router = APIRouter(prefix="/api/v1/platform", tags=["platform-v3"])

FEATURES = [
    (1,"Mapas y ubicación en tiempo real","delivery","production","GPS del navegador, tracking WebSocket y mapa Leaflet/OpenStreetMap; proveedor de tiles configurable."),
    (2,"Pagos reales","checkout","provider-required","Checkout Pro, Webhook firmado y reembolsos reales con Mercado Pago al configurar credenciales productivas."),
    (3,"Notificaciones","customer","production","Centro persistente, lectura y eventos de pedido en tiempo real."),
    (4,"Promociones y cupones","growth","production-core","Descuentos y códigos aplicables en checkout; gestión comercial ampliable desde ADMIN."),
    (5,"Favoritos y pedir de nuevo","customer","production","Favoritos persistentes e historial reutilizable."),
    (6,"Ratings y reseñas","trust","production","Calificación de restaurante y repartidor tras una entrega."),
    (7,"Chat","support","production","Mensajes persistentes asociados al pedido y evento realtime."),
    (8,"Asignación automática de repartidores","delivery","production","Selecciona repartidor online priorizando distancia GPS y carga."),
    (9,"Zonas de cobertura","delivery","production","Radio real calculado con coordenadas del restaurante y cliente."),
    (10,"Tarifas de envío dinámicas","checkout","production","Base + distancia calculada por servidor; pickup sin tarifa."),
    (11,"Portal restaurante avanzado","restaurant","production","Stock, extras, combos, KDS y operación del restaurante."),
    (12,"Portal repartidor avanzado","driver","production","Disponibilidad, GPS, ganancias y entregas."),
    (13,"ADMIN avanzado","admin","production","KPIs, usuarios, comisiones, pedidos, soporte, riesgo y ajustes auditados de Wallet."),
    (14,"Centro de soporte","support","production-core","Tickets persistentes por pedido/categoría; flujo operativo listo para mesa de ayuda."),
    (15,"Seguridad reforzada","security","production","Cookies HttpOnly/Secure, roles, CORS, hosts, rate limit, headers y auditoría de requests."),
    (16,"Restaurantes patrocinados","growth","production-core","Marcado sponsored y prioridad visual; contratación comercial se gestiona fuera del checkout."),
    (17,"Comisiones automáticas","finance","production-core","Cálculo contable de comisión, payout y ganancia de repartidor; dispersión bancaria requiere onboarding financiero."),
    (18,"Wallet Tala Eats","finance","production","Saldo interno con ledger transaccional, idempotencia, canjes, cargos y reembolsos auditables."),
    (19,"Referidos","growth","partial-production","Código único persistente; automatización de recompensa por referido queda como siguiente integración comercial."),
    (20,"IA para recomendaciones/ETA","ai","production-rules","Motor determinista de recomendaciones y ETA; un modelo externo es opcional y requiere credenciales."),
    (21,"Pedidos programados","customer","production-core","scheduled_for persistente; scheduler avanzado de despacho puede añadirse con worker."),
    (22,"Pedidos grupales","customer","production-core","group_code persistente para agrupar órdenes."),
    (23,"Tala Eats Plus","growth","partial-production","Estado de membresía y beneficios implementados; cobro recurrente requiere suscripción del proveedor de pagos."),
    (24,"Recoger en restaurante","customer","production","Pickup sin repartidor ni tarifa de envío."),
    (25,"Puntos y recompensas","growth","production","Puntos al completar pedidos y canje auditado a Wallet."),
    (26,"Gift Cards","finance","production-core","Códigos y saldos persistentes; canje a Wallet con registro transaccional."),
    (27,"Filtros alimenticios","catalog","production","Etiquetas vegetariano/vegano/sin gluten persistentes."),
    (28,"Información de alérgenos","catalog","production","Alérgenos visibles por producto."),
    (29,"Combos y extras","catalog","production","Productos combo y opciones serializadas."),
    (30,"Kitchen Display System","restaurant","production","KDS por etapas; pedidos de Mercado Pago solo aparecen tras pago confirmado."),
    (31,"Roles dentro del restaurante","restaurant","production-core","Empleados con roles manager/cashier/kitchen en la base y API."),
    (32,"Integración POS","integration","provider-required","URL de POS configurable; cada proveedor exige contrato/API propia."),
    (33,"Facturación/CFDI","finance","provider-required","Solicitud y RFC persistentes; timbrado real exige credenciales de un PAC autorizado."),
    (34,"Verificación de restaurantes","trust","production-core","Estado de verificación persistente y administrable por ADMIN."),
    (35,"Verificación de repartidores","trust","production-core","Estado de verificación del repartidor persistente y administrable."),
    (36,"Detección de fraude","security","production-core","Reglas iniciales y banderas auditables; puede conectarse un motor antifraude externo."),
    (37,"Asignación segura de entregas","delivery","production-core","Cada repartidor mantiene una sola entrega activa; la asignación usa locks para evitar dobles asignaciones concurrentes."),
    (38,"Prueba de entrega","delivery","production","PIN, foto subida al servidor y coordenadas de entrega."),
    (39,"Geofencing","delivery","production","Backend calcula llegada al restaurante y cercanía al cliente con GPS."),
    (40,"PWA instalable","frontend","production","Manifest y service worker sin cachear APIs ni datos sensibles."),
    (41,"Recuperación de contraseña","identity","production-core","Tokens de un solo uso con expiración y envío por cola SMTP."),
    (42,"Perfil y direcciones autogestionables","customer","production","Perfil editable y CRUD de direcciones con principal."),
    (43,"Correo transaccional","platform","production-core","Outbox persistente procesado por worker; SMTP configurable sin bloquear el core."),
    (44,"Checkout idempotente","checkout","production","Referencia por cliente evita duplicados al repetir una confirmación."),
    (45,"Auditoría sensible","security","production-core","Eventos de perfil, recuperación y automatizaciones quedan trazados."),
    (46,"Readiness de producción","operations","production","Health report y script verifican DB, Redis, worker y checkout core."),
    (47,"Planes comerciales por restaurante","monetization","production","START, DELIVERY y PRO con comisión y tarifa de servicio configurables por negocio."),
    (48,"Tarifa de servicio","monetization","production","Tarifa porcentual/mínima integrada al checkout y conciliación financiera."),
    (49,"Unit economics por pedido","finance","production","Comisión, servicio, logística, procesamiento, subsidio, revenue y margen por pedido."),
    (50,"Ledger financiero","finance","production","Libro contable interno idempotente para GMV, payables, ingresos y costos."),
    (51,"Payouts","finance","production-core","Generación y conciliación de pagos a restaurantes/repartidores; transferencia real requiere proveedor bancario."),
    (52,"Control de efectivo","finance","production","Conciliación de efectivo cobrado por repartidores y saldo a entregar."),
    (53,"Onboarding de restaurantes","merchant","production","Solicitud, documentos, RFC, cuenta de payout, aprobación y activación por ADMIN."),
    (54,"Onboarding de repartidores","driver","production","Solicitud, vehículo, documentos, verificación y activación por ADMIN."),
    (55,"Zonas de servicio","operations","production","Zonas radiales configurables con cobertura, recargo y pedido mínimo."),
    (56,"Command Center","operations","production","Pedidos activos, tiendas online, drivers, retrasos, incidentes, GMV y margen en vivo."),
    (57,"SLA operativo","operations","production","Tiempos de aceptación, preparación, entrega y ciclo completo medidos por eventos."),
    (58,"Disputas","trust","production","Apertura, revisión, resolución y reembolso a Wallet con auditoría."),
    (59,"Política de cancelación por etapa","trust","production","Cancelación gratis/10%/30% según etapa, con estimación previa y trazabilidad."),
    (60,"Suscripción Tala Eats Plus","growth","production-core","Suscripción persistente, renovación y precio configurable; cobro recurrente real depende del proveedor."),
    (61,"Publicidad patrocinada","ads","production-core","Campañas por restaurante con presupuesto, gasto, impresiones, clics y atribución."),
    (62,"Referidos automáticos","growth","production","Recompensa bloqueada hasta primer pedido válido y crédito idempotente en Wallet."),
    (63,"Feature flags","platform","production","Activación por rol y porcentaje para liberar funciones gradualmente."),
    (64,"Configuración dinámica","platform","production","Parámetros comerciales/operativos editables desde ADMIN sin redeploy."),
    (65,"Modo simulación","qa","production","Happy path, efectivo, cancelación y falta de repartidor sin dinero/inventario reales."),
    (66,"Eventos de pedido","observability","production","Timeline persistente de cambios de estado para auditoría y SLA."),
    (67,"Centro financiero restaurante","merchant","production","Ventas, comisión, neto por pagar y payouts por restaurante."),
    (68,"Centro financiero repartidor","driver","production","Ganancias, propinas, efectivo y payouts por repartidor."),
    (69,"Sucursales y marca","merchant","production-core","Campos de marca y código de sucursal preparados por restaurante/sucursal."),
    (70,"Roles de equipo","merchant","production","Owner, manager, cashier y kitchen con permisos operativos."),
    (71,"Promociones con subsidio medible","growth","production-core","Subsidio Tala Eats separado del descuento para medir margen real."),
    (72,"Observabilidad de worker","operations","production","Heartbeat, readiness y fallos operativos visibles desde health/Command Center."),
    (73,"Auditoría administrativa","security","production","Cambios comerciales, onboarding, payouts, settings, flags y simulaciones auditados."),
    (74,"Arquitectura mobile-ready","platform","production","Contrato API estable por roles para reutilizar en Android/iOS después de cerrar web."),
    (75,"Despacho inteligente V9","delivery","production-rules","Ranking de repartidores por distancia, carga, rating y experiencia con autoasignación."),
    (76,"ETA dinámico V9","delivery","production-rules","Recalcula ETA por etapa, carga de cocina, distancia y heurística de hora pico."),
    (77,"Heatmap operativo","operations","production","Demanda, pedidos activos, GMV y presión por celdas geográficas."),
    (78,"Incentivos de alta demanda","driver","production-core","Bonos y multiplicadores temporales administrables y creación automática básica."),
    (79,"Predicción de demanda","intelligence","production-rules","Forecast horario usando histórico móvil de 56 días y señal reciente."),
    (80,"Recomendaciones personalizadas","growth","production-rules","Ranking individual por historial, favoritos, horario, rating y patrocinio."),
    (81,"Búsqueda inteligente","catalog","production-rules","Interpreta intención de precio, desayuno, saludable, familia y términos del catálogo."),
    (82,"CRM de clientes","growth","production","Segmentos new, active, frequent, VIP, at-risk e inactive con LTV."),
    (83,"Marketing automatizado","growth","production-core","Triggers de inactividad, cumpleaños, carrito abandonado, primera compra, VIP y riesgo."),
    (84,"Loyalty por niveles","growth","production","Bronze, Silver, Gold y Black con rachas, misiones y beneficios."),
    (85,"Tala Eats Plus 2.0","growth","production","Ahorro acumulado y propuesta de valor basada en pedidos reales."),
    (86,"Perfil avanzado de restaurante","merchant","production","Catálogo, disponibilidad, rating, horarios lógicos, promociones y disponibilidad efectiva."),
    (87,"Merchant Intelligence","merchant","production","Top productos, recurrencia, horas pico, revenue y alertas de ingredientes."),
    (88,"Forecast de cocina","merchant","production-rules","Predice carga próxima y riesgo de retraso para KDS."),
    (89,"Menú inteligente por horario","catalog","production","Ventanas de disponibilidad y precios/multiplicadores por día y hora."),
    (90,"Inventario por ingredientes","merchant","production","Recetas consumen ingredientes y bloquean checkout ante faltantes."),
    (91,"Mermas y costo estimado","merchant","production","Registra desperdicio y costo para control operativo."),
    (92,"Driver Score transparente","driver","production-rules","Score explicable por puntualidad, completitud y rating, sin sanciones automáticas."),
    (93,"Trust & Safety V9","trust","production-rules","Señales de reembolsos, cancelaciones, alias y anomalías para revisión humana."),
    (94,"Centro de incidentes","operations","production","Detecta retrasos, falta de repartidor e inactividad con acción sugerida."),
    (95,"Reasignación automática","delivery","production-rules","Worker reasigna pedidos estancados cuando existe mejor candidato."),
    (96,"Chat contextual multimedia","support","production","Texto, respuestas rápidas, foto privada y ubicación por pedido."),
    (97,"Pedido para otra persona","customer","production","Receptor, teléfono y mensaje de regalo persistentes en la orden."),
    (98,"Pedidos grupales 2.0","customer","production","Carrito colaborativo por código, participantes, bloqueo y payload consolidado."),
    (99,"Pedidos corporativos","b2b","production-core","Cuentas, miembros, presupuestos, centros de costo, estado de cuenta y conciliación interna."),
    (100,"Marketplace multi-ciudad","platform","production-core","Market code por sucursal y resumen de mercados activos."),
    (101,"Selección multi-sucursal","merchant","production-rules","Elige la mejor sucursal de una marca por distancia y carga de cocina."),
    (102,"Motor comercial configurable","monetization","production","Comisiones, service fee, planes y reglas se modifican sin redeploy."),
    (103,"A/B testing","growth","production","Asignación determinista, rollout y conversión por métrica de producto."),
    (104,"Analytics de funnel","analytics","production","Mide app_open → search → restaurant → cart → checkout → delivery."),
    (105,"Event tracking","analytics","production","Eventos de producto persistentes por sesión/usuario para decisiones de UX y growth."),
    (106,"Observabilidad unificada","operations","production","Estado interno de DB, Redis, worker, pagos, correo, WebSocket e incidentes."),
    (107,"Modo degradado/offline V9","frontend","production-core","PWA mantiene shell y catálogo público reciente sin cachear información privada."),
    (108,"Centro de privacidad","privacy","production","Exportación, opt-out de marketing, solicitudes de eliminación y sesiones visibles."),
    (109,"2FA TOTP para operadores","security","production","TOTP RFC6238 para ADMIN/restaurantes y gestión de dispositivos/sesiones."),
    (110,"Partner API","integration","production-core","Claves con scopes para catálogo y base extensible a POS/ERP/cadenas."),
    (111,"Batching de entregas","delivery","production-rules","Sugiere y asigna pares compatibles de entregas del mismo restaurante."),
    (112,"Intelligence V9 sin lock-in ML","intelligence","production-rules","Motores explicables funcionan con reglas/histórico y pueden evolucionar a ML cuando haya datos suficientes."),
]


def loyalty(db: Session, user_id: int):
    return get_loyalty_account(db, user_id)


@router.get("/features", response_model=schemas.PlatformOverview)
def features():
    return {"version": settings.app_version, "feature_count": len(FEATURES), "features": [dict(id=i,name=n,area=a,mode=m,description=d) for i,n,a,m,d in FEATURES]}


@router.get("/promotions", response_model=list[schemas.PromotionPublic])
def promotions(db: Session = Depends(get_db)):
    return db.scalars(select(models.Promotion).where(models.Promotion.active.is_(True)).order_by(models.Promotion.sponsored.desc()).limit(200)).all()


@router.get("/coupons", response_model=list[schemas.CouponPublic])
def coupons(db: Session = Depends(get_db)):
    return db.scalars(select(models.Coupon).where(models.Coupon.active.is_(True)).limit(200)).all()


@router.get("/addresses", response_model=list[schemas.AddressPublic])
def addresses(user: models.User = Depends(require_role("customer","admin")), db: Session = Depends(get_db)):
    return db.scalars(select(models.Address).where(models.Address.user_id == user.id).order_by(models.Address.is_default.desc())).all()


@router.post("/addresses", response_model=schemas.AddressPublic, status_code=201)
def create_address(payload: schemas.AddressCreate, user: models.User = Depends(require_role("customer","admin")), db: Session = Depends(get_db)):
    if payload.is_default:
        for row in db.scalars(select(models.Address).where(models.Address.user_id == user.id)).all():
            row.is_default = False
    row = models.Address(user_id=user.id, **payload.model_dump())
    db.add(row); db.commit(); db.refresh(row); return row


@router.patch("/addresses/{address_id}", response_model=schemas.AddressPublic)
def update_address(address_id: int, payload: schemas.AddressUpdate, user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.scalar(select(models.Address).where(models.Address.id == address_id, models.Address.user_id == user.id))
    if not row:
        raise HTTPException(404, "Dirección no encontrada")
    values = payload.model_dump(exclude_unset=True)
    if values.get("is_default"):
        for existing in db.scalars(select(models.Address).where(models.Address.user_id == user.id)).all():
            existing.is_default = False
    for key, value in values.items():
        setattr(row, key, value)
    db.commit(); db.refresh(row)
    return row


@router.delete("/addresses/{address_id}", status_code=204)
def delete_address(address_id: int, user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.scalar(select(models.Address).where(models.Address.id == address_id, models.Address.user_id == user.id))
    if not row:
        raise HTTPException(404, "Dirección no encontrada")
    was_default = row.is_default
    db.delete(row); db.flush()
    if was_default:
        replacement = db.scalar(select(models.Address).where(models.Address.user_id == user.id).order_by(models.Address.id))
        if replacement:
            replacement.is_default = True
    db.commit()


@router.get("/bootstrap")
def customer_bootstrap(user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    account = get_loyalty_account(db, user.id)
    unread = db.scalar(select(func.count(models.Notification.id)).where(models.Notification.user_id == user.id, models.Notification.is_read.is_(False))) or 0
    return {
        "user": schemas.UserPublic.model_validate(user).model_dump(mode="json"),
        "wallet": {"balance": str(account.wallet_balance), "points": account.points, "plus_member": account.plus_member, "referral_code": account.referral_code},
        "unread_notifications": unread,
        "support_email": settings.support_email,
        "online_payments": bool(settings.mercado_pago_access_token),
        "google_signin": bool(settings.google_client_id),
    }


@router.get("/favorites", response_model=list[schemas.RestaurantPublic])
def favorites(user: models.User = Depends(require_role("customer","admin")), db: Session = Depends(get_db)):
    ids = db.scalars(select(models.Favorite.restaurant_id).where(models.Favorite.user_id == user.id)).all()
    return db.scalars(select(models.Restaurant).where(models.Restaurant.id.in_(ids))).all() if ids else []


@router.post("/favorites/{restaurant_id}")
def toggle_favorite(restaurant_id: int, user: models.User = Depends(require_role("customer","admin")), db: Session = Depends(get_db)):
    if not db.get(models.Restaurant, restaurant_id):
        raise HTTPException(404,"Restaurante no encontrado")
    row = db.scalar(select(models.Favorite).where(models.Favorite.user_id == user.id, models.Favorite.restaurant_id == restaurant_id))
    if row:
        db.delete(row); state=False
    else:
        db.add(models.Favorite(user_id=user.id, restaurant_id=restaurant_id)); state=True
    db.commit(); return {"favorite": state}


@router.get("/loyalty", response_model=schemas.LoyaltyPublic)
def get_loyalty(user: models.User = Depends(require_role("customer","admin")), db: Session = Depends(get_db)):
    account = loyalty(db,user.id); db.commit(); db.refresh(account); return account


@router.get("/wallet", response_model=schemas.WalletSummary)
def wallet_summary(user: models.User = Depends(require_role("customer","admin")), db: Session = Depends(get_db)):
    account = loyalty(db, user.id)
    db.commit(); db.refresh(account)
    transactions = db.scalars(select(models.WalletTransaction).where(models.WalletTransaction.user_id == user.id).order_by(models.WalletTransaction.created_at.desc()).limit(20)).all()
    return {"balance": account.wallet_balance, "points": account.points, "plus_member": account.plus_member, "referral_code": account.referral_code, "transactions": transactions}


@router.get("/wallet/transactions", response_model=list[schemas.WalletTransactionPublic])
def wallet_transactions(user: models.User = Depends(require_role("customer","admin")), db: Session = Depends(get_db)):
    return db.scalars(select(models.WalletTransaction).where(models.WalletTransaction.user_id == user.id).order_by(models.WalletTransaction.created_at.desc()).limit(100)).all()


@router.post("/gift-cards/redeem", response_model=schemas.LoyaltyPublic)
def redeem_gift(payload: schemas.GiftRedeem, user: models.User = Depends(require_role("customer","admin")), db: Session = Depends(get_db)):
    code = payload.code.upper().strip()
    card = db.scalar(select(models.GiftCard).where(models.GiftCard.code == code).with_for_update())
    if not card or not card.active or card.balance <= 0:
        raise HTTPException(400,"Gift Card inválida o sin saldo")
    value = Decimal(card.balance)
    account = get_loyalty_account(db, user.id, lock=True)
    credit_wallet(db, user.id, value, kind="gift_card", reference_type="gift_card", reference_id=code, description=f"Canje de Gift Card {code}", idempotency_key=f"gift-card:{card.id}", account=account)
    card.balance=Decimal("0"); card.active=False
    db.commit(); db.refresh(account); return account


@router.get("/notifications", response_model=list[schemas.NotificationPublic])
def notifications(user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    return db.scalars(select(models.Notification).where(models.Notification.user_id == user.id).order_by(models.Notification.created_at.desc()).limit(50)).all()


@router.patch("/notifications/{notification_id}/read", response_model=schemas.NotificationPublic)
def notification_read(notification_id: int, user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.get(models.Notification, notification_id)
    if not row or row.user_id != user.id:
        raise HTTPException(404, "Notificación no encontrada")
    row.is_read = True; db.commit(); db.refresh(row); return row


@router.post("/notifications/read-all")
def notifications_read_all(user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    result = db.execute(
        update(models.Notification)
        .where(models.Notification.user_id == user.id, models.Notification.is_read.is_(False))
        .values(is_read=True)
    )
    db.commit()
    return {"updated": int(result.rowcount or 0)}


@router.post("/reviews", response_model=schemas.ReviewPublic, status_code=201)
def review(payload: schemas.ReviewCreate, user: models.User = Depends(require_role("customer")), db: Session = Depends(get_db)):
    order=db.get(models.Order,payload.order_id)
    if not order or order.user_id != user.id or order.status != "delivered":
        raise HTTPException(400,"Solo puedes calificar pedidos entregados propios")
    if db.scalar(select(models.Review).where(models.Review.order_id == order.id, models.Review.user_id == user.id)):
        raise HTTPException(409, "Este pedido ya fue calificado")
    row=models.Review(order_id=order.id,user_id=user.id,restaurant_id=order.restaurant_id,driver_id=order.driver_id,**payload.model_dump(exclude={"order_id"}))
    db.add(row); db.commit(); db.refresh(row); return row


@router.get("/orders/{order_id}/chat", response_model=list[schemas.ChatPublic])
def chat(order_id:int, user:models.User=Depends(get_current_user), db:Session=Depends(get_db)):
    order=db.get(models.Order,order_id)
    if not order: raise HTTPException(404,"Pedido no encontrado")
    rest=db.get(models.Restaurant,order.restaurant_id)
    if user.role!="admin" and user.id not in {order.user_id,order.driver_id} and not (user.role=="restaurant" and rest and rest.owner_id==user.id):
        raise HTTPException(403,"Sin acceso")
    rows = db.scalars(
        select(models.ChatMessage)
        .where(models.ChatMessage.order_id == order_id)
        .order_by(models.ChatMessage.created_at.desc())
        .limit(500)
    ).all()
    rows.reverse()
    return rows


@router.post("/orders/{order_id}/chat", response_model=schemas.ChatPublic, status_code=201)
def send_chat(order_id:int,payload:schemas.ChatCreate,user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    chat(order_id,user,db)
    row=models.ChatMessage(order_id=order_id,sender_id=user.id,message=payload.message,message_type=payload.message_type,media_url=payload.media_url,lat=payload.lat,lng=payload.lng)
    db.add(row); db.commit(); db.refresh(row); publish_order_event(order_id,"chat.message",{"message_id":row.id,"sender_id":user.id}); return row


@router.get("/support", response_model=list[schemas.SupportPublic])
def support_list(user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    stmt=select(models.SupportTicket).order_by(models.SupportTicket.created_at.desc())
    if user.role!="admin": stmt=stmt.where(models.SupportTicket.user_id==user.id)
    return db.scalars(stmt.limit(200)).all()


@router.post("/support", response_model=schemas.SupportPublic, status_code=201)
def support_create(payload:schemas.SupportCreate,user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    if payload.order_id is not None:
        order = db.get(models.Order, payload.order_id)
        if not order or (user.role != "admin" and order.user_id != user.id):
            raise HTTPException(404, "Pedido no encontrado")
    row=models.SupportTicket(user_id=user.id,**payload.model_dump()); db.add(row); db.commit(); db.refresh(row); return row


@router.get("/recommendations")
def recommendations(user:models.User=Depends(require_role("customer","admin")),db:Session=Depends(get_db)):
    rows=db.scalars(select(models.Restaurant).where(models.Restaurant.is_open.is_(True)).order_by(models.Restaurant.sponsored.desc(),models.Restaurant.rating.desc()).limit(6)).all()
    return {"engine": settings.ai_provider, "message":"Recomendaciones basadas en patrocinio, rating y disponibilidad; AI_PROVIDER puede sustituir el motor de reglas.", "restaurants":[schemas.RestaurantPublic.model_validate(r).model_dump(mode="json") for r in rows]}


@router.post("/plus/subscribe", response_model=schemas.LoyaltyPublic)
def subscribe_plus(user: models.User = Depends(require_role("customer")), db: Session = Depends(get_db)):
    account = loyalty(db, user.id)
    account.plus_member = True
    db.commit(); db.refresh(account); return account


@router.post("/rewards/redeem")
def redeem_points(points: int, user: models.User = Depends(require_role("customer")), db: Session = Depends(get_db)):
    if points < 100:
        raise HTTPException(400, "El mínimo de canje es 100 puntos")
    account = get_loyalty_account(db, user.id, lock=True)
    if account.points < points:
        raise HTTPException(400, "No tienes puntos suficientes")
    credit = (Decimal(points) / Decimal("10")).quantize(Decimal("0.01"))
    account.points -= points
    txn = credit_wallet(db, user.id, credit, kind="points_reward", reference_type="points", reference_id=str(points), description=f"Canje de {points} puntos", account=account)
    db.commit(); db.refresh(account)
    return {"points": account.points, "wallet_balance": str(account.wallet_balance), "credit_added": str(credit), "transaction_id": txn.id}


@router.get("/groups/{group_code}")
def group_orders(group_code: str, user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    stmt = select(models.Order).where(models.Order.group_code == group_code.strip())
    if user.role != "admin":
        stmt = stmt.where(models.Order.user_id == user.id)
    rows = db.scalars(stmt.order_by(models.Order.created_at).limit(200)).all()
    return [{"id": o.id, "status": o.status, "total": str(o.total), "scheduled_for": o.scheduled_for} for o in rows]


@router.get("/referral")
def referral(user: models.User = Depends(require_role("customer")), db: Session = Depends(get_db)):
    account = loyalty(db, user.id); db.commit(); db.refresh(account)
    return {"code": account.referral_code, "reward_rule": "Código persistente listo; la política de recompensa se configura en la capa comercial."}
