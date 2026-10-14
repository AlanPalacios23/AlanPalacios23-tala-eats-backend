from decimal import Decimal
from sqlalchemy import select, text
from sqlalchemy.orm import Session
from . import models
from .security import hash_password

def seed_database(db:Session):
    # Production can start multiple Uvicorn workers at the same time.
    # Serialize demo seeding in PostgreSQL so only one worker mutates the DB.
    if db.get_bind().dialect.name == "postgresql":
        db.execute(
            text("SELECT pg_advisory_xact_lock(:lock_key)"),
            {"lock_key": 140014001},
        )

    # A worker that waited on the advisory lock must re-check after the first
    # worker commits. This also keeps normal restarts idempotent.
    if db.scalar(select(models.User.id).limit(1)):
        return
    admin=models.User(name="Administrador Tala Eats",email="admin@talaeats.mx",password_hash=hash_password("Admin123!"),role="admin",phone="3310000001")
    owner=models.User(name="Restaurante Demo",email="restaurante@talaeats.mx",password_hash=hash_password("Restaurante123!"),role="restaurant",phone="3310000002")
    customer=models.User(name="Cliente Demo",email="cliente@talaeats.mx",password_hash=hash_password("Cliente123!"),role="customer",phone="3310000003")
    driver=models.User(name="Carlos Repartidor",email="repartidor@talaeats.mx",password_hash=hash_password("Repartidor123!"),role="driver",phone="3310000004")
    db.add_all([admin,owner,customer,driver]);db.flush()
    db.add(models.DriverProfile(user_id=driver.id,vehicle="Motocicleta",plate="TALA-01",is_online=True,is_verified=True,rating=Decimal("4.96"),current_lat=20.6527,current_lng=-103.7037))
    tacos=models.Restaurant(name="Tacos El Centro",description="Tacos, quesadillas y especialidades al estilo de Tala.",cuisine="Mexicana",emoji="🌮",eta_min=25,delivery_fee=Decimal("15"),per_km_fee=Decimal("3.5"),owner_id=owner.id,lat=20.6526,lng=-103.7035,sponsored=True,rating=Decimal("4.90"))
    pizza=models.Restaurant(name="Pizza Tala",description="Pizzas recién horneadas para compartir.",cuisine="Pizza",emoji="🍕",eta_min=35,delivery_fee=Decimal("18"),per_km_fee=Decimal("4"),lat=20.656,lng=-103.701,rating=Decimal("4.76"))
    burgers=models.Restaurant(name="Burger 453",description="Hamburguesas, papas y bebidas.",cuisine="Hamburguesas",emoji="🍔",eta_min=30,delivery_fee=Decimal("12"),per_km_fee=Decimal("4.2"),lat=20.649,lng=-103.708,rating=Decimal("4.82"))
    coffee=models.Restaurant(name="Café Alameda",description="Café, desayunos y postres.",cuisine="Café",emoji="☕",eta_min=20,delivery_fee=Decimal("10"),per_km_fee=Decimal("3"),lat=20.654,lng=-103.705,rating=Decimal("4.88"))
    db.add_all([tacos,pizza,burgers,coffee]);db.flush()
    db.add_all([
        models.MenuItem(restaurant_id=tacos.id,name="Orden de tacos",description="5 tacos de asada con cebolla y cilantro",category="Tacos",price=Decimal("85"),stock=40,dietary_tags="alto en proteína",allergens="",options_json='["Asada","Pastor","Mixtos"]'),
        models.MenuItem(restaurant_id=tacos.id,name="Combo taquero",description="5 tacos + agua fresca",category="Combos",price=Decimal("110"),stock=25,is_combo=True,options_json='["Horchata","Jamaica","Limón"]'),
        models.MenuItem(restaurant_id=tacos.id,name="Quesadilla con carne",description="Tortilla, queso y carne a elegir",category="Especialidades",price=Decimal("65"),stock=30,allergens="lácteos, gluten"),
        models.MenuItem(restaurant_id=pizza.id,name="Pizza pepperoni",description="Pizza grande de pepperoni",category="Pizzas",price=Decimal("189"),stock=20,allergens="gluten, lácteos",options_json='["Orilla normal","Orilla con queso +$35"]'),
        models.MenuItem(restaurant_id=pizza.id,name="Pizza vegetariana",description="Pimientos, champiñón, cebolla y aceitunas",category="Pizzas",price=Decimal("205"),stock=18,dietary_tags="vegetariano",allergens="gluten, lácteos"),
        models.MenuItem(restaurant_id=burgers.id,name="Burger clásica",description="Carne, queso, vegetales y aderezo",category="Hamburguesas",price=Decimal("119"),stock=35,allergens="gluten, lácteos",options_json='["Queso extra +$15","Tocino +$25","Papas +$30"]'),
        models.MenuItem(restaurant_id=burgers.id,name="Burger vegana",description="Medallón vegetal y vegetales",category="Hamburguesas",price=Decimal("129"),stock=15,dietary_tags="vegano",allergens="gluten"),
        models.MenuItem(restaurant_id=coffee.id,name="Latte vainilla",description="Espresso, leche y vainilla",category="Café",price=Decimal("58"),stock=50,allergens="lácteos",options_json='["Leche normal","Almendra +$12","Avena +$12"]'),
        models.MenuItem(restaurant_id=coffee.id,name="Bowl de fruta",description="Fruta de temporada con granola",category="Desayuno",price=Decimal("72"),stock=20,dietary_tags="vegetariano",allergens="nueces"),
    ])
    # Alembic v1.4 creates several core flags before the application starts.
    # Seed only missing flags so a clean production DB and demo DB share the
    # same startup path without unique-key races.
    feature_flags = [
        ("ops.command_center", "Command Center operativo", True, 100, "admin"),
        ("commerce.plus", "Tala Eats Plus", True, 100, "customer"),
        ("merchant.ads", "Campañas patrocinadas", True, 100, "restaurant"),
        ("core.durable_outbox", "Outbox transaccional durable V1.4", True, 100, "all"),
        ("payments.reconciliation", "Conciliación automática de pagos", True, 100, "admin"),
        ("dispatch.v2", "Dispatch ETA + fairness V2", True, 100, "driver"),
        ("security.fraud_v14", "Señales antifraude explicables", True, 100, "admin"),
        ("geo.postgis", "Aceleración geoespacial PostGIS", False, 0, "all"),
    ]
    existing_flag_keys = set(db.scalars(select(models.FeatureFlag.key)).all())
    for key, description, enabled, rollout_percent, audience_role in feature_flags:
        if key not in existing_flag_keys:
            db.add(models.FeatureFlag(
                key=key,
                description=description,
                enabled=enabled,
                rollout_percent=rollout_percent,
                audience_role=audience_role,
            ))

    db.add_all([
        models.Coupon(code="TALA20",discount_type="percent",value=Decimal("20"),min_order=Decimal("100"),description="20% de descuento en pedidos desde $100"),
        models.Coupon(code="ENVIO50",discount_type="fixed",value=Decimal("50"),min_order=Decimal("180"),description="$50 de descuento"),
        models.Promotion(restaurant_id=tacos.id,title="🔥 20% en favoritos locales",description="Promoción demo V3",discount_percent=20,sponsored=True),
        models.Promotion(restaurant_id=burgers.id,title="🍔 Combo de la semana",description="Descuento especial en combos",discount_percent=15),
        models.GiftCard(code="REGALO100",balance=Decimal("100")),
        models.VerificationRecord(entity_type="restaurant",entity_id=tacos.id,status="approved",notes="Documentación demo validada"),
        models.VerificationRecord(entity_type="driver",entity_id=driver.id,status="approved",notes="Identidad y vehículo demo validados"),
        models.Address(user_id=customer.id,label="Casa",address="Centro, Tala, Jalisco",lat=20.6534,lng=-103.7040,is_default=True),
        models.LoyaltyAccount(user_id=customer.id,points=240,wallet_balance=Decimal("75"),plus_member=True,referral_code="TALAALAN"),
        models.Notification(user_id=customer.id,kind="promo",title="Bienvenido a Tala Eats V6",message="Tienes TALA20 disponible y 240 puntos."),
        models.ServiceZone(name="Tala Centro",center_lat=20.6534,center_lng=-103.7040,radius_km=8.0,surcharge=Decimal("0"),min_order=Decimal("80"),active=True),
        models.SystemSetting(key="service_fee_rate",value="0.0400",value_type="decimal",description="Tarifa de servicio base"),
        models.SystemSetting(key="service_fee_min",value="5.00",value_type="decimal",description="Tarifa de servicio mínima"),
        models.SystemSetting(key="driver_share_of_delivery_fee",value="0.7000",value_type="decimal",description="Porción de envío para repartidor"),
        models.SystemSetting(key="payment_processing_rate",value="0.0350",value_type="decimal",description="Costo variable estimado de pasarela"),
        models.SystemSetting(key="payment_processing_fixed",value="4.00",value_type="decimal",description="Costo fijo estimado de pasarela"),
        models.SystemSetting(key="plus_monthly_price",value="79.00",value_type="decimal",description="Precio mensual Tala Eats Plus"),
        models.SystemSetting(key="referral_reward",value="50.00",value_type="decimal",description="Recompensa por referido válido"),
    ])
    db.commit()
