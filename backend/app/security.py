import base64
import hashlib
import hmac
import os
from datetime import datetime, timedelta, timezone

import jwt

from .config import settings


PBKDF2_ITERATIONS = 600_000


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        scheme, iterations, salt_b64, digest_b64 = stored_hash.split("$", 3)
        if scheme != "pbkdf2_sha256":
            return False
        parsed_iterations = int(iterations)
        if parsed_iterations < 100_000 or parsed_iterations > 2_000_000:
            return False
        salt = base64.b64decode(salt_b64, validate=True)
        expected = base64.b64decode(digest_b64, validate=True)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, parsed_iterations)
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def create_access_token(user_id: int, role: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "role": role,
        "iat": now,
        "exp": now + timedelta(minutes=settings.access_token_minutes),
        "jti": base64.urlsafe_b64encode(os.urandom(18)).decode().rstrip("="),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> dict:
    return jwt.decode(
        token,
        settings.jwt_secret,
        algorithms=[settings.jwt_algorithm],
        leeway=settings.jwt_leeway_seconds,
        options={"require": ["exp", "iat", "sub"]},
    )


def create_device_attestation(user_id: int, device_id_hash: str, days: int = 180) -> str:
    """Issue an optional signed proof binding an installation identifier to a user.

    Existing clients remain compatible if they do not send it. New mobile clients can
    persist this token and send it as X-Device-Token together with X-Device-ID.
    """
    if not device_id_hash:
        return ""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "device": device_id_hash,
        "typ": "talaeats-device",
        "iat": now,
        "exp": now + timedelta(days=max(1, min(days, 365))),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def verify_device_attestation(token: str, user_id: int, raw_device_id: str) -> bool:
    if not token or not raw_device_id:
        return False
    try:
        payload = jwt.decode(
            token, settings.jwt_secret, algorithms=[settings.jwt_algorithm],
            leeway=settings.jwt_leeway_seconds, options={"require": ["exp", "iat", "sub"]},
        )
        expected = hashlib.sha256(raw_device_id.encode()).hexdigest()
        return (
            payload.get("typ") == "talaeats-device"
            and hmac.compare_digest(str(payload.get("sub", "")), str(user_id))
            and hmac.compare_digest(str(payload.get("device", "")), expected)
        )
    except Exception:
        return False


# RFC 6238 TOTP helpers used by V9 operator 2FA.
def generate_totp_secret() -> str:
    return base64.b32encode(os.urandom(20)).decode().rstrip("=")


def _totp_code(secret: str, counter: int, digits: int = 6) -> str:
    import struct
    padding = "=" * ((8 - len(secret) % 8) % 8)
    key = base64.b32decode(secret + padding, casefold=True)
    msg = struct.pack(">Q", counter)
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = (struct.unpack(">I", digest[offset:offset+4])[0] & 0x7FFFFFFF) % (10 ** digits)
    return f"{value:0{digits}d}"


def verify_totp(secret: str, code: str, window: int = 1) -> bool:
    import time
    if not secret or not code or not code.isdigit() or len(code) != 6:
        return False
    counter = int(time.time() // 30)
    try:
        return any(hmac.compare_digest(_totp_code(secret, counter + drift), code) for drift in range(-window, window + 1))
    except (ValueError, TypeError):
        return False
