from sqlalchemy import select

from app import models
from app.db import SessionLocal
from app.seed import seed_database


def test_seed_is_idempotent_when_v14_feature_flags_already_exist():
    with SessionLocal() as db:
        # conftest already seeds once; a production restart/second worker must
        # not insert duplicate flags or users.
        before_users = len(db.scalars(select(models.User.id)).all())
        before_flags = len(db.scalars(select(models.FeatureFlag.key)).all())
        seed_database(db)
        db.commit()
        after_users = len(db.scalars(select(models.User.id)).all())
        after_flags = len(db.scalars(select(models.FeatureFlag.key)).all())
        assert after_users == before_users
        assert after_flags == before_flags
        assert db.scalar(select(models.FeatureFlag).where(models.FeatureFlag.key == "core.durable_outbox")) is not None
