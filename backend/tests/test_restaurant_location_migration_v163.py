"""Exercise f21i without a real PG server; PostgreSQL staging is still required."""
import importlib.util
from pathlib import Path
from alembic.runtime.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, text


def test_address_migration_preserves_existing_restaurant_coordinates():
    migration = (
        Path(__file__).resolve().parents[1]
        / "migrations/versions/f21i00000001_restaurant_pickup_address.py"
    )
    spec = importlib.util.spec_from_file_location("f21i_location_migration", migration)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.down_revision == "f20h00000001"
    engine = create_engine("sqlite+pysqlite:///:memory:")
    try:
        with engine.begin() as conn:
            conn.execute(text("CREATE TABLE restaurants (id INTEGER PRIMARY KEY, name VARCHAR(150), lat REAL, lng REAL)"))
            conn.execute(text("INSERT INTO restaurants (id,name,lat,lng) VALUES (1,'Tienda QA',20.654,-103.704)"))
            operations = Operations(MigrationContext.configure(conn))
            old_op = mod.op
            mod.op = operations
            try:
                mod.upgrade()
            finally:
                mod.op = old_op
            result = conn.execute(text("SELECT address,lat,lng FROM restaurants WHERE id=1")).one()
            assert result.address == ""
            assert result.lat == 20.654
            assert result.lng == -103.704
            conn.execute(text("UPDATE restaurants SET address='Calle Test 123' WHERE id=1"))
            assert conn.scalar(text("SELECT address FROM restaurants WHERE id=1")) == "Calle Test 123"
    finally:
        engine.dispose()
