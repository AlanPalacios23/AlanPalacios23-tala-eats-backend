#!/usr/bin/env python3
"""Minimal loopback-only static legal origin for TALA EATS.
No dependency on the ordering API, Stripe, PostgreSQL, Nginx or private keys.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

BASE = Path("/var/www/talaeats-legal")
ALLOWED = {
    "/privacidad": BASE / "privacidad/index.html",
    "/privacidad/": BASE / "privacidad/index.html",
    "/eliminar-cuenta": BASE / "eliminar-cuenta/index.html",
    "/eliminar-cuenta/": BASE / "eliminar-cuenta/index.html",
}

class LegalHandler(BaseHTTPRequestHandler):
    server_version = "TalaEatsLegal"
    sys_version = ""

    def do_GET(self):
        self.respond(body=True)

    def do_HEAD(self):
        self.respond(body=False)

    def respond(self, body):
        path = urlsplit(self.path).path
        file = ALLOWED.get(path)
        if file is None:
            self.send_error(404, "Not Found")
            return
        try:
            html = file.read_bytes()
        except OSError:
            self.send_error(503, "Static page unavailable")
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(html)))
        self.send_header("Cache-Control", "public, max-age=300")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
        self.end_headers()
        if body:
            self.wfile.write(html)

    def log_message(self, fmt, *args):
        # Do not log query params, remote tokens, customer data, or IPs.
        pass

if __name__ == "__main__":
    with ThreadingHTTPServer(("127.0.0.1", 18191), LegalHandler) as server:
        print("TALAEATS_LEGAL_LOOPBACK_STARTED port=18191", flush=True)
        server.serve_forever(poll_interval=0.5)
