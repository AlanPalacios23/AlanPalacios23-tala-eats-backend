#!/usr/bin/env python3
"""Read-only route and reverse-proxy discovery on Kali; never prints secrets."""
import json
import shutil
import subprocess
import urllib.error
import urllib.request

BASE = "https://talaeats.alan-palacios-dev.com"

def http_status(path):
    request = urllib.request.Request(BASE + path, method="GET",
        headers={"Accept":"text/html,application/json","User-Agent":"TalaEats-Legal-ReadOnly/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, response.headers.get_content_type()
    except urllib.error.HTTPError as error:
        return error.code, "blocked_or_error"
    except Exception:
        return 0, "unreachable"

def dockinfo(name):
    result = subprocess.run(["docker", "inspect", "--type", "container", name],
        capture_output=True, text=True, timeout=10)
    if result.returncode:
        print("CONTAINER", name, "NOT_FOUND_OR_NO_ACCESS")
        return
    data=json.loads(result.stdout)[0]
    print("CONTAINER",name,"PRESENT", "state="+data.get("State",{}).get("Status","?"))
    labels=data.get("Config",{}).get("Labels") or {}
    print("  PROJECT",labels.get("com.docker.compose.project","unknown"))
    if "caddy" in name:
        for mount in data.get("Mounts",[]):
            if mount.get("Destination") in ("/etc/caddy/Caddyfile","/etc/caddy","/srv","/usr/share/caddy"):
                # Print path of mount that actually controls Caddy, but no file content.
                print("  CADDY_MOUNT",mount.get("Destination"),mount.get("Type"),mount.get("Source"))

def main():
    print("TALAEATS_LEGAL_PREFLIGHT_READONLY")
    for route in ("/privacidad","/eliminar-cuenta","/api/v1/health"):
        code,ctype=http_status(route)
        print("PUBLIC_GET",route,"HTTP_"+str(code),"type="+ctype)
    if shutil.which("docker"):
        for name in ("talaeats-v3-caddy-1","talaeats-v3-frontend-1","tala-node-live-api"):
            try:
                dockinfo(name)
            except Exception:
                print("CONTAINER",name,"UNKNOWN")
    else:
        print("DOCKER_NOT_INSTALLED")
    print("HOST_NGINX_INSTALLED",bool(shutil.which("nginx")))
    print("CLOUDFLARED_BIN_INSTALLED",bool(shutil.which("cloudflared")))
    print("READONLY_PASS: no config, containers, DB, Stripe, API or tunnels changed")

if __name__ == "__main__":
    main()
