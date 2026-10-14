"""Read-only public readiness checker for GitHub Actions monitoring.

No SSH, no auth, no environment metadata, and no mutation endpoint.
A nonzero exit lets GitHub Actions notify maintainers IF notifications are set.
"""
import json
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

def check():
    if not READY.startswith("https://talaeats.alan-palacios-dev.com/api/v1/ready"):
        raise ValueError("Unapproved production URL")
    try:
        with urlopen(READY, timeout=12, context=ssl.create_default_context()) as response:
            status, data = response.status, json.load(response)
    except (HTTPError, URLError, TimeoutError, ValueError):
        raise SystemExit("PUBLIC_READINESS_FAIL: health check unreachable or invalid")
    if not evaluate(status, data):
        raise SystemExit("PUBLIC_READINESS_FAIL: API or PostgreSQL/Redis degraded")
    # Only public version, health flags. Never print full server diagnostic JSON.
    print("PUBLIC_READINESS_PASS", data["version"], "db=True redis=True")

def self_test():
    good = {"ready": True, "database": True, "redis": True, "version": "qa"}
    assert evaluate(200, good)
    assert not evaluate(503, good)
    for field in ("ready", "database", "redis"):
        bad = {**good, field: False}
        assert not evaluate(200, bad)
    assert not evaluate(200, {**good, "version": ""})
    assert not evaluate(200, {})
    print("PUBLIC_MONITOR_SELFTEST_PASS")

if __name__ == "__main__":
    import sys
    self_test() if "--self-test" in sys.argv else check()
