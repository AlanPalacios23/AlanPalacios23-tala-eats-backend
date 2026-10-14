"""No-test-dependency security smoke. Run only inside isolated QA container.
No live keys, no Stripe network, and no payout creation.
"""
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch
from fastapi import HTTPException
from app.routes import withdrawals as w
from app.config import settings


def reject(fn, code):
    try:
        fn()
    except HTTPException as exc:
        assert exc.status_code == code, (exc.status_code, code)
    else:
        raise AssertionError(f"Unsafe action passed: expected HTTP {code}")


# Prevent untrusted redirect URLs from being handed to authenticated users.
for url in ("http://connect.stripe.com/setup", "https://evil.example/a",
            "https://connect.stripe.com.evil.example/a",
            "https://user:pass@connect.stripe.com/a",
            "https://connect.stripe.com:443/a", "//connect.stripe.com/a"):
    reject(lambda url=url: w._safe_stripe_link(url), 502)
assert w._safe_stripe_link("https://connect.stripe.com/setup/c/test")

account = {"id": "acct_Original123456", "country": "MX", "livemode": True,
           "type": "express", "metadata": {"tala_role": "restaurant",
           "tala_recipient_id": "4", "tala_owner_user_id": "12"}}
with patch.object(w, "_live_mode", return_value=True):
    w._verified_account_binding(account, ref=account["id"], user_id=12,
                                role="restaurant", recipient_id=4)
    for changes in ({"country": "US"}, {"livemode": False}, {"type": "standard"},
                    {"metadata": {}},
                    {"metadata": {**account["metadata"], "tala_owner_user_id": "77"}},
                    {"metadata": {**account["metadata"], "tala_recipient_id": "5"}}):
        changed = {**account, **changes}
        reject(lambda changed=changed: w._verified_account_binding(
            changed, ref=account["id"], user_id=12, role="restaurant", recipient_id=4), 409)

owner = SimpleNamespace(id=12, two_factor_enabled=True, totp_secret="test-totp-secret")
with patch.object(w, "_rate_limit_2fa", return_value=None), patch.object(w, "verify_totp", side_effect=lambda s, c: c == "123456"):
    reject(lambda: w._connect_step_up(owner, "restaurant", 4, account["id"], None), 403)
    reject(lambda: w._connect_step_up(owner, "restaurant", 4, account["id"], "999999"), 403)

# Simulate shared Redis replay guard, do not persist real OTP.
class FakeRedis:
    def __init__(self): self.keys = set()
    def set(self, key, value, **kwargs):
        if kwargs.get("nx") and key in self.keys: return False
        self.keys.add(key)
        return True

cache=FakeRedis()
with patch.object(w, "_rate_limit_2fa", return_value=None), patch.object(w, "verify_totp", return_value=True), \
     patch.object(w, "redis_client", return_value=cache), patch.object(type(settings), "is_production", property(lambda self: True)):
    w._connect_step_up(owner, "restaurant", 4, account["id"], "123456")
    reject(lambda: w._connect_step_up(owner, "restaurant", 4, account["id"], "123456"), 409)

# Existing 2FA cannot be reset by an authenticated-but-stolen session.
from app.routes import v9
original = SimpleNamespace(id=17, email="verified@example.test", role="driver",
                           totp_secret="EXISTING_SECRET", two_factor_enabled=True)
class DB:
    def commit(self): pass
reject(lambda: v9.two_factor_setup(original, DB()), 409)
assert original.totp_secret == "EXISTING_SECRET" and original.two_factor_enabled
new_driver = SimpleNamespace(id=18, email="driver@example.test", role="driver",
                             totp_secret="", two_factor_enabled=False)
with patch.object(v9, "generate_totp_secret", return_value="SAFETOTPSAFETOTP"):
    issued = v9.two_factor_setup(new_driver, DB())
assert issued["enabled"] is False and new_driver.totp_secret == "SAFETOTPSAFETOTP"
print("SECURITY SMOKE v1.6.4-HF1: PASS — ownership, bank link, OTP replay, and 2FA setup")
