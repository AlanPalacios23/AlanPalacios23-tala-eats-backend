from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from sqlalchemy.pool import StaticPool

from .config import settings


if settings.database_url.startswith("sqlite"):
    connect_args = {"check_same_thread": False}
else:
    pg_options = " ".join(
        [
            f"-c statement_timeout={settings.db_statement_timeout_ms}",
            f"-c lock_timeout={settings.db_lock_timeout_ms}",
            f"-c idle_in_transaction_session_timeout={settings.db_idle_tx_timeout_ms}",
            "-c application_name=talaeats-api",
        ]
    )
    connect_args = {"options": pg_options}

engine_kwargs = {
    "pool_pre_ping": True,
    "connect_args": connect_args,
}
if settings.database_url in {"sqlite://", "sqlite:///:memory:"}:
    # Test/dev in-memory DB shared across FastAPI's worker threads.
    engine_kwargs["poolclass"] = StaticPool
if not settings.database_url.startswith("sqlite"):
    engine_kwargs.update(
        pool_size=settings.db_pool_size,
        max_overflow=settings.db_max_overflow,
        pool_timeout=settings.db_pool_timeout,
        pool_recycle=settings.db_pool_recycle,
        pool_use_lifo=True,
        pool_reset_on_return="rollback",
    )

engine = create_engine(settings.database_url, **engine_kwargs)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


# Optional read replica. Hot analytical/read-only services may opt in without
# changing the transactional primary used by checkout, payments and dispatch.
ReadSessionLocal = SessionLocal
read_engine = engine
if settings.read_database_url and settings.read_database_url != settings.database_url and not settings.read_database_url.startswith("sqlite"):
    read_connect_args = {"options": f"-c statement_timeout={settings.db_statement_timeout_ms} -c application_name=talaeats-read"}
    read_engine = create_engine(
        settings.read_database_url,
        pool_pre_ping=True,
        pool_size=settings.db_pool_size,
        max_overflow=settings.db_max_overflow,
        pool_timeout=settings.db_pool_timeout,
        pool_recycle=settings.db_pool_recycle,
        pool_use_lifo=True,
        pool_reset_on_return="rollback",
        connect_args=read_connect_args,
    )
    ReadSessionLocal = sessionmaker(bind=read_engine, autoflush=False, autocommit=False, expire_on_commit=False)


def get_read_db():
    db = ReadSessionLocal()
    try:
        yield db
    finally:
        db.close()
