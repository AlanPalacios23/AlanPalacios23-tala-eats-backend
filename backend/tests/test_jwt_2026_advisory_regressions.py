"""JWT security regressions. All tokens and keys in these tests are synthetic."""
from datetime import datetime, timedelta, timezone

import jwt
import pytest

from app.config import settings
from app.security import decode_access_token


def test_expired_signed_jwt_cannot_bypass_claim_verification():
    now = datetime.now(timezone.utc)
    expired = jwt.encode(
        {"sub": "123", "iat": now - timedelta(days=2), "exp": now - timedelta(days=1)},
        settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
    )
    with pytest.raises(jwt.ExpiredSignatureError):
        decode_access_token(expired)


def test_unverified_decode_never_mutates_options_dict_used_by_caller():
    """Regression for GHSA-gvp8-978c-rx2q: caller options must not be changed."""
    now = datetime.now(timezone.utc)
    expired = jwt.encode(
        {"sub": "123", "iat": now - timedelta(days=2), "exp": now - timedelta(days=1)},
        settings.jwt_secret,
        algorithm="HS256",
    )
    options = {"verify_signature": False}
    jwt.decode(expired, options=options)
    assert options == {"verify_signature": False}
    options["verify_signature"] = True
    with pytest.raises(jwt.ExpiredSignatureError):
        jwt.decode(expired, settings.jwt_secret, algorithms=["HS256"], options=options)
