#!/usr/bin/env python3
"""Safe static file staging only; does not publish or reload reverse proxy."""
import argparse
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parent
FILES={"privacidad":ROOT/"site/privacidad/index.html",
       "eliminar-cuenta":ROOT/"site/eliminar-cuenta/index.html"}
DEST=Path("/var/www/talaeats-legal")

def run(command):
    subprocess.run(command,check=True)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--stage", action="store_true", help="copy only to an isolated directory; does NOT activate URLs")
    args=parser.parse_args()
    run([sys.executable,str(ROOT/"validar_legal.py")])
    for name,file in FILES.items():
        if not file.is_file() or not file.stat().st_size:
            raise SystemExit("MISSING_HTML "+name)
        if (DEST/name/"index.html").exists():
            raise SystemExit("REFUSED_EXISTING_TARGET "+name)
    print("PLAN_ONLY" if not args.stage else "STAGING_LEGAL_PAGES")
    print("TARGET_DIRECTORY",DEST)
    if not args.stage:
        print("NO_CHANGES: run with --stage to copy without routing")
        return
    for name,file in FILES.items():
        run(["sudo","install","-d","-m","0755",str(DEST/name)])
        run(["sudo","install","-m","0644",str(file),str(DEST/name/"index.html")])
    print("LEGAL_STATIC_STAGED_PASS")
    print("ROUTES_NOT_ACTIVE: must configure actual Caddy/Nginx/Cloudflare proxy after reviewing topology")
    print("NO_API_STRIPE_OR_DB_CHANGES")

if __name__ == "__main__":
    main()
