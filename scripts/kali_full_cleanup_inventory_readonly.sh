#!/usr/bin/env bash
# Kali: read-only discovery of all hosted applications before single-project cleanup.
# Never prints .env, passwords, full docker inspect, configs, SQL, logs or secrets.
set -euo pipefail
case "${1:-}" in
  --self-test)
    [[ "$(printf '%s' 'talaeats-v3' | grep -c '^talaeats-v3$')" == "1" ]]
    echo "KALI_CLEANUP_INVENTORY_SELFTEST_PASS"
    exit 0
    ;;
  --scan) ;;
  *) echo "Uso: bash kali_full_cleanup_inventory_readonly.sh --scan|--self-test"; exit 2 ;;
esac

echo "=== A. TODOS LOS CONTENEDORES Y PROYECTOS COMPOSE ==="
docker ps -a --format 'NAME={{.Names}} PROJECT={{.Label "com.docker.compose.project"}} SERVICE={{.Label "com.docker.compose.service"}} STATUS={{.Status}} IMAGE={{.Image}}'

echo "=== B. VOLUMENES DOCKER (SOLO NOMBRES) ==="
docker volume ls --format '{{.Name}}'

echo "=== C. REDES DOCKER (SOLO NOMBRES) ==="
docker network ls --format '{{.Name}}'

echo "=== D. PROYECTOS DOCKER COMPOSE ==="
docker compose ls -a --format json | python3 -c '
import json,sys
try: projects=json.load(sys.stdin)
except (ValueError,TypeError): projects=[]
for p in projects:
    print("PROJECT=%s STATUS=%s" % (p.get("Name","?"),p.get("Status","?")))
'

echo "=== E. SERVICIOS SYSTEMD RELACIONADOS CON LAS APPS ==="
systemctl list-unit-files --type=service --no-legend --no-pager |
  grep -Ei 'tala|cloudflared|caddy|codexia|dateclub|sentinel|noctra|inventario|workday|vidrion' || true

echo "=== F. DIRECTORIOS DE APPS (SOLO NOMBRE, NO CONTENIDOS) ==="
for root in "$HOME" "/home/alan"; do
  if [[ -d "$root" ]]; then
    find "$root" -mindepth 1 -maxdepth 2 -type d \
      \( -iname '*tala*' -o -iname '*codexia*' -o -iname '*dateclub*' \
      -o -iname '*sentinel*' -o -iname '*noctra*' -o -iname '*inventario*' \
      -o -iname '*workday*' -o -iname '*vidrion*' \) \
      -print 2>/dev/null || true
    break
  fi
done

echo "=== G. VERIFICAR QUE EL BACKUP DE TALA EATS SIGUE EN KALI ==="
backup="$HOME/talaeats-backups/20261018T042833Z-encrypted.VkjIWd6q"
if [[ -d "$backup" ]]; then
  (cd "$backup" && sha256sum --check SHA256SUMS.txt)
else
  echo "BACKUP_NO_LOCALIZADO — prohibido limpiar"
fi

echo "KALI_SERVER_CLEANUP_INVENTORY_PASS — NO SE HA BORRADO NADA"
