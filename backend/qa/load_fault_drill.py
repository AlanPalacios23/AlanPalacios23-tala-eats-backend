"""HTTP performance and fault recovery drill against a localhost QA-only API.

NEVER accepts external hosts. 120 concurrent GETs are a pilot micro-load, not a
promise of 200/1,000 daily orders or a production capacity benchmark.
"""
import argparse
import asyncio
import json
import os
import statistics
import time
from urllib.request import urlopen
from urllib.error import HTTPError
import httpx

BASE = "http://127.0.0.1:18211"

def guard():
    assert os.environ.get("DATABASE_URL") == (
        "postgresql+psycopg://talaqa:qa-only-local@127.0.0.1:5432/talaqa")
    assert os.environ.get("ENVIRONMENT") == "development"
    assert os.environ.get("STRIPE_ENABLED") == "false"
    assert not os.environ.get("STRIPE_SECRET_KEY")
    assert os.environ.get("WITHDRAWALS_EXECUTION_ENABLED") == "false"

def ready():
    try:
        with urlopen(BASE + "/api/v1/ready", timeout=12) as resp:
            return resp.status, json.load(resp)
    except HTTPError as exc:
        return exc.code, json.load(exc)

async def load():
    guard()
    code, payload = ready()
    assert code == 200 and payload["ready"], (code, payload)
    paths = ("/api/v1/ready", "/api/v1/restaurants", "/api/v1/health")
    latencies = []
    errors = []
    sem = asyncio.Semaphore(12)

    async with httpx.AsyncClient(timeout=httpx.Timeout(10, connect=4)) as client:
        async def request(i):
            path = paths[i % len(paths)]
            async with sem:
                start = time.perf_counter()
                try:
                    r = await client.get(BASE + path)
                    latencies.append((time.perf_counter() - start) * 1000)
                    if r.status_code != 200:
                        errors.append((path, r.status_code))
                except (httpx.HTTPError, OSError) as exc:
                    errors.append((path, type(exc).__name__))
        await asyncio.gather(*(request(i) for i in range(120)))

    assert not errors, ("Unexpected HTTP / networking errors", errors[:8])
    p95 = sorted(latencies)[int(.95 * (len(latencies) - 1))]
    avg = statistics.mean(latencies)
    assert p95 < 4000, ("Pilot micro-load p95 exceeded 4s", round(p95))
    print("PILOT_MICROLOAD_PASS", "requests", len(latencies),
          "p95_ms", round(p95), "avg_ms", round(avg), "http_errors", len(errors))

def check(expected):
    guard()
    last = None
    for _ in range(12):
        try:
            code, body = ready()
            last = code
            if code == expected and body["ready"] == (expected == 200):
                print(("REDIS_FAILURE_READINESS_PASS" if expected == 503 else "HEALTH_RECOVERED_PASS"),
                      "HTTP", code)
                return
        except Exception as exc:
            last = type(exc).__name__
        time.sleep(1)
    raise AssertionError(("Readiness did not reach expected status", expected, last))

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["load", "healthy", "redis-outage"])
    args = parser.parse_args()
    asyncio.run(load()) if args.mode == "load" else check(503 if args.mode == "redis-outage" else 200)
