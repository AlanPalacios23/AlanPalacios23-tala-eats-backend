#!/usr/bin/env python3
"""F2.05 passive external readiness diagnostic. NEVER modifies Kali/WAF.

Only GET https://talaeats.alan-palacios-dev.com/api/v1/ready; never
sends authentication, cookies, tokens, headers, POST, or private credentials.
Offline --self-test has no network access. Actual run must be initiated
deliberately outside production.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import ssl
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPHandler, HTTPSHandler, HTTPRedirectHandler

EXPECTED = "https://talaeats.alan-palacios-dev.com/api/v1/ready"
MAX_BODY = 8192


@dataclass(frozen=True)
class ProbeResult:
    status: str
    code: int
    safe_note: str
    verified: bool


def require_url(url: str) -> None:
    parsed = urlsplit(url)
    if (url != EXPECTED or parsed.scheme != "https"
            or parsed.hostname != "talaeats.alan-palacios-dev.com"
            or parsed.username or parsed.password or parsed.port
            or parsed.query or parsed.fragment or parsed.path != "/api/v1/ready"):
        raise ValueError("F205 only the public HTTPS readiness endpoint is permitted")


def classify(code: int, body: bytes) -> ProbeResult:
    if code == 403:
        return ProbeResult("BLOCKED_EXTERNAL_403", 403,
                           "HTTP 403 desde esta red; revisar WAF/Caddy/Cloudflare SIN apertura global", False)
    if code != 200:
        return ProbeResult("UNEXPECTED_HTTP_STATUS", code,
                           "Readiness externo requiere HTTP 200; no inferir causa del estado", False)
    if not isinstance(body, bytes) or len(body) > MAX_BODY:
        return ProbeResult("INVALID_RESPONSE_SIZE", code,
                           "Contenido ausente, ilegible o mayor que 8 KiB", False)
    try:
        data = json.loads(body)
    except (UnicodeDecodeError, ValueError, TypeError):
        return ProbeResult("NOT_JSON_READY", code,
                           "HTTP 200 no contenía JSON válido de readiness", False)
    if not isinstance(data, dict):
        return ProbeResult("INVALID_READY_CONTRACT", code,
                           "Readiness debe ser objeto JSON", False)
    for field in ("ready", "database", "redis"):
        if data.get(field) is not True:
            return ProbeResult("DEPENDENCY_OR_CONTRACT_NOT_READY", code,
                               "Readiness no confirma ready/database/redis=true simultáneamente", False)
    return ProbeResult("EXTERNAL_READY_OBSERVED", code,
                       "HTTP 200 con ready/database/redis=true observados desde esta red", True)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def probe(url: str) -> ProbeResult:
    require_url(url)
    opener = build_opener(HTTPHandler(), HTTPSHandler(context=ssl.create_default_context()), NoRedirect())
    try:
        with opener.open(Request(url, method="GET"), timeout=12) as response:
            body = response.read(MAX_BODY + 1)
            return classify(response.status, body)
    except HTTPError as exc:
        # HTTPError may contain WAF HTML, IP, or incident IDs. Never log it.
        return classify(exc.code, b"")
    except (URLError, TimeoutError, OSError):
        return ProbeResult("TRANSPORT_OR_TLS_ERROR", 0,
                           "No pudo verificarse conectividad/TLS desde esta red", False)


def self_test() -> None:
    require_url(EXPECTED)
    for wrong in (
        EXPECTED.replace("https:", "http:"),
        EXPECTED + "?token=test",
        "https://example.com/api/v1/ready",
        "https://talaeats.alan-palacios-dev.com@evil.example/api/v1/ready",
        "https://talaeats.alan-palacios-dev.com/api/v1/health",
    ):
        try:
            require_url(wrong)
        except ValueError:
            pass
        else:
            raise AssertionError("F205 unsafe target accepted")
    cases = (
        (403, b"<html>waf</html>", "BLOCKED_EXTERNAL_403", False),
        (200, b"<html>challenge</html>", "NOT_JSON_READY", False),
        (200, b'{"ready":true,"database":true,"redis":true}', "EXTERNAL_READY_OBSERVED", True),
        (200, b'{"ready":true,"database":true,"redis":"true"}', "DEPENDENCY_OR_CONTRACT_NOT_READY", False),
        (200, b'{"ready":true,"database":false,"redis":true}', "DEPENDENCY_OR_CONTRACT_NOT_READY", False),
        (502, b"bad gateway", "UNEXPECTED_HTTP_STATUS", False),
        (301, b"", "UNEXPECTED_HTTP_STATUS", False),
        (200, b"[]" , "INVALID_READY_CONTRACT", False),
        (200, b"x" * (MAX_BODY + 1), "INVALID_RESPONSE_SIZE", False),
    )
    for code, body, status, ok in cases:
        result = classify(code, body)
        assert result.status == status and result.verified is ok, result
    print("F205_OFFLINE_WAF_HTTP_AND_READINESS_CONTRACT_SELFTEST_PASS")


def main() -> int:
    parser = argparse.ArgumentParser(description="F2.05 public readiness diagnostic (read-only)")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--url", default=EXPECTED)
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    result = probe(args.url)
    # Only safe, whitelisted fields; never expose raw HTML / tokens / IP.
    print(json.dumps({
        "status": result.status, "http_status": result.code,
        "verified": result.verified, "explanation": result.safe_note,
        "notice": "A single probe is not a 24/7 availability certification",
    }, ensure_ascii=False))
    return 0 if result.verified else 2


if __name__ == "__main__":
    raise SystemExit(main())
