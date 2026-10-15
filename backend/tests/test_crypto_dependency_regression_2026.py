"""Regresión de autenticación y cifrado con dependencias actualizadas.

No requiere Stripe, Firebase, REDIS externo ni secretos reales.
"""
from datetime import datetime, timedelta, timezone

import jwt
import pytest
from cryptography.fernet import Fernet, InvalidToken

from app.security import create_access_token, decode_access_token, create_device_attestation, verify_device_attestation
from app.config import settings


def test_real_access_token_still_decodes_with_pinned_algorithm():
    token = create_access_token(71, "driver")
    payload = decode_access_token(token)
    assert payload["sub"] == "71"
    assert payload["role"] == "driver"
    assert payload["exp"] > payload["iat"]


def test_expired_and_wrong_signature_never_authenticate():
    expired = jwt.encode(
        {"sub": "71", "iat": datetime.now(timezone.utc) - timedelta(days=2),
         "exp": datetime.now(timezone.utc) - timedelta(days=1)},
        settings.jwt_secret, algorithm="HS256")
    with pytest.raises(jwt.ExpiredSignatureError):
        decode_access_token(expired)
    token = jwt.encode(
        {"sub": "71", "iat": datetime.now(timezone.utc),
         "exp": datetime.now(timezone.utc) + timedelta(hours=1)},
        "wrong-secret", algorithm="HS256")
    with pytest.raises(jwt.InvalidSignatureError):
        decode_access_token(token)


def test_device_attestation_bound_to_user_and_device():
    from hashlib import sha256
    raw = "test-installation-45"
    proof = create_device_attestation(71, sha256(raw.encode()).hexdigest())
    assert verify_device_attestation(proof, 71, raw)
    assert not verify_device_attestation(proof, 72, raw)
    assert not verify_device_attestation(proof, 71, raw + "-other")


def test_fernet_roundtrip_and_modified_ciphertext_rejected():
    box = Fernet(Fernet.generate_key())
    text = b"fcm-token-fake-do-not-send"
    ciphertext = box.encrypt(text)
    assert box.decrypt(ciphertext) == text
    with pytest.raises(InvalidToken):
        box.decrypt(ciphertext[:-5] + b"garbage")
