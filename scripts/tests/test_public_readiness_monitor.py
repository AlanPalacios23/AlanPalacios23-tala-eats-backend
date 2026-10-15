"""No-network tests of HTTP readiness categories (run tomorrow on Windows)."""
import importlib.util
import json
from pathlib import Path
import unittest
from urllib.error import HTTPError


SCRIPT = Path(__file__).resolve().parents[1] / "check_public_readiness.py"
spec = importlib.util.spec_from_file_location("tala_ready", SCRIPT)
assert spec is not None and spec.loader is not None
ready = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ready)


class PublicReadinessContract(unittest.TestCase):
    def test_healthy_payload(self):
        data = {"ready": True, "database": True, "redis": True, "version": "qa"}
        status, loaded = ready.parse_readiness_response(
            200, "application/json; charset=utf-8", json.dumps(data).encode()
        )
        self.assertTrue(ready.evaluate(status, loaded))

    def test_non_json_auth_redirect_and_large_response(self):
        with self.assertRaises(ready.InvalidContentType):
            ready.parse_readiness_response(200, "text/html", b"<html>login</html>")
        with self.assertRaises(ready.ReadinessPayloadTooLarge):
            ready.parse_readiness_response(200, "application/json", b"x" * (ready.MAX_BODY_BYTES + 1))
        self.assertEqual(
            ready.failure_category(HTTPError(ready.READY, 302, "redirect", None, None)),
            "HTTP_302",
        )

    def test_missing_health_fails(self):
        for key in ("ready", "database", "redis", "version"):
            payload = {"ready": True, "database": True, "redis": True, "version": "qa"}
            payload.pop(key)
            self.assertFalse(ready.evaluate(200, payload))

    def test_response_does_not_log_body(self):
        marker = "NO_PRINT_POTENTIAL_USER_DATA"
        with self.assertRaises(json.JSONDecodeError) as raised:
            ready.parse_readiness_response(200, "application/json", marker.encode())
        self.assertEqual(ready.failure_category(raised.exception), "INVALID_JSON")


if __name__ == "__main__":
    unittest.main()
