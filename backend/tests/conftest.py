import os
# Configure a deterministic disposable database before any test module imports app.main.
os.environ["DATABASE_URL"] = "sqlite://"
os.environ["JWT_SECRET"] = "test-secret-at-least-40-bytes-long-for-tala-eats-v5"
os.environ["ENVIRONMENT"] = "development"
os.environ["SEED_DEMO_DATA"] = "true"

import pytest


@pytest.fixture(autouse=True)
def reset_database():
    """Give every test a clean seeded database.

    The previous suite shared one SQLite database across tests, so redeeming a gift
    card or enabling 2FA in one test could make unrelated tests fail later.
    """
    from app import models  # noqa: F401 - registers all metadata
    from app.db import Base, SessionLocal, engine
    from app.seed import seed_database

    engine.dispose()
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        seed_database(db)
    yield
    engine.dispose()
