#!/usr/bin/env python3
"""Install a SEPARATE legal-only origin. Never touch Cloudflared, Node, Stripe, DB."""
import argparse
import socket
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEST = Path("/usr/local/lib/talaeats-legal/server.py")
SERVICE = Path("/etc/systemd/system/talaeats-legal-static.service")

def cmd(*argv):
    subprocess.run(argv, check=True)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--install", action="store_true",
                        help="requires sudo; install and start the isolated origin")
    args = parser.parse_args()
    cmd(sys.executable, str(ROOT / "validar_legal.py"))
    if not (ROOT / "server.py").is_file():
        raise SystemExit("MISSING_SERVER_SOURCE")
    for doc in ("privacidad", "eliminar-cuenta"):
        path = Path("/var/www/talaeats-legal") / doc / "index.html"
        if not path.is_file():
            raise SystemExit("MISSING_STAGED_HTML " + doc)
    if not args.install:
        print("LEGAL_ORIGIN_PLAN_ONLY")
        print("New service: talaeats-legal-static; port=127.0.0.1:18191")
        print("No edits to /etc/cloudflared/config.yml, Nginx, Node, DB or Stripe")
        return
    if SERVICE.exists() or DEST.exists():
        raise SystemExit("ALREADY_INSTALLED: inspect existing unit/origin; not overwriting")
    with socket.socket() as conn:
        if conn.connect_ex(("127.0.0.1", 18191)) == 0:
            raise SystemExit("PORT_18191_IN_USE: refusing to touch existing service")
    cmd("sudo", "install", "-d", "-m", "0755", str(DEST.parent))
    cmd("sudo", "install", "-m", "0644", str(ROOT / "server.py"), str(DEST))
    cmd("sudo", "install", "-m", "0644", str(ROOT / "talaeats-legal-static.service"), str(SERVICE))
    cmd("sudo", "systemctl", "daemon-reload")
    cmd("sudo", "systemctl", "enable", "--now", "talaeats-legal-static.service")
    print("LEGAL_LOCAL_ORIGIN_INSTALLED")
    print("NEXT: curl -fIs http://127.0.0.1:18191/privacidad")
    print("NEXT: curl -fIs http://127.0.0.1:18191/eliminar-cuenta")
    print("NOT_YET_PUBLIC: must validate then configure Cloudflared ingress rules")
    print("NODE_18190_UNTOUCHED, PAYMENTS_UNTOUCHED, CLOUDFLARED_UNTOUCHED")

if __name__ == "__main__":
    main()
