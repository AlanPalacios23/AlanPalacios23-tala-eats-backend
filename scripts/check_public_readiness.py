"""Read-only public readiness checker for GitHub Actions monitoring.

No SSH, no auth, no environment metadata, and no mutation endpoint.
Diagnostics are fixed error categories, never exception strings or response bodies.
A nonzero exit lets GitHub Actions notify maintainers IF notifications are set.
"""
import json
import socket
import ssl
from urllib.request import urlopen
from urllib.error import HTTPError, URLError

READY = "https://talaeats.alan-palacios-dev.com/api/v1/ready"


def evaluate(status, data):
    if status != 200 or not isinstance(data, dict):
        return False
    return (data.get("ready") is True and data.get("database") is True
            and data.get("redis") is True and isinstance(data.get("version"), str)
            and bool(data["version"]))


def failure_category(exc):
    """Produce actionable but bounded telemetry; never log URI, response or secrets."""
    if isinstance(exc, HTTPError):
        status = exc.code
        return f"HTTP_{status}" if isinstance(status, int) and 100 <= status <= 599 else "HTTP_ERROR"
    if isinstance(exc, ssl.SSLError):
        return "TLS_FAILURE"
    if isinstance(exc, URLError):
        reason = exc.reason
        if isinstance(reason, ssl.SSLError):
            return "TLS_FAILURE"
        if isinstance(reason, socket.gaierror):
            return "DNS_FAILURE"
        if isinstance(reason, (TimeoutError, socket.timeout)):
            return "TIMEOUT"
        if isinstance(reason, ConnectionRefusedError):
            return "CONNECTION_REFUSED"
        return "NETWORK_FAILURE"
    if isinstance(exc, (TimeoutError, socket.timeout)):
        return "TIMEOUT"
    if isinstance(exc, (ValueError, UnicodeDecodeError)):
        return "INVALID_JSON"
    return "UNKNOWN_FAILURE"


def check():
    if READY != "https://talaeats.alan-palacios-dev.com/api/v1/ready":
        raise ValueError("Unapproved production URL")
    try:
        with urlopen(READY, timeout=12, context=ssl.create_default_context()) as response:
            status, data = response.status, json.load(response)
    except (HTTPError, URLError, TimeoutError, ssl.SSLError,
            ValueError, UnicodeDecodeError) as exc:
        raise SystemExit(f"PUBLIC_READINESS_FAIL:{failure_category(exc)}") from None
    if not evaluate(status, data):
        raise SystemExit("PUBLIC_READINESS_FAIL:DEGRADED_OR_MISSING_FIELDS")
    # Only public version and health flags; never print full server diagnostic JSON.
    print("PUBLIC_READINESS_PASS", data["version"], "db=True redis=True")


def self_test():
    good = {"ready": True, "database": True, "redis": True, "version": "qa"}
    assert evaluate(200, good)
    assert not evaluate(503, good)
    for field in ("ready", "database", "redis"):
        assert not evaluate(200, {**good, field: False})
    assert not evaluate(200, {**good, "version": ""})
    assert not evaluate(200, {})
    # These are synthetic exceptions. No network connection or secret is made.
    assert failure_category(HTTPError(READY, 403, "do-not-print", None, None)) == "HTTP_403"
    assert failure_category(URLError(socket.gaierror(-2, "do-not-print"))) == "DNS_FAILURE"
    assert failure_category(URLError(ssl.SSLError("do-not-print"))) == "TLS_FAILURE"
    assert failure_category(URLError(TimeoutError("do-not-print"))) == "TIMEOUT"
    assert failure_category(URLError(ConnectionRefusedError("do-not-print"))) == "CONNECTION_REFUSED"
    assert failure_category(URLError("do-not-print")) == "NETWORK_FAILURE"
    assert failure_category(json.JSONDecodeError("do-not-print", "x", 0)) == "INVALID_JSON"
    print("PUBLIC_MONITOR_SELFTEST_PASS")


if __name__ == "__main__":
    import sys
    self_test() if "--self-test" in sys.argv else check()
