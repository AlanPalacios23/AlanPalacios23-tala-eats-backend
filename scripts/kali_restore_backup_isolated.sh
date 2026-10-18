#!/usr/bin/env bash
# One-run proof of RESTORABILITY of the actual October 18 encrypted backup.
# PostgreSQL scratch container has NO network, NO ports, NO host volumes.
# Real Tala Eats DB/API/Worker/Stripe never touched. Fails closed.
set -Eeuo pipefail
umask 077

BACKUP="$HOME/talaeats-backups/20261018T042833Z-encrypted.VkjIWd6q"
HELPER="${TALA_MEDIA_RESTORE_PROBE:-$HOME/tala-backend-audit/scripts/kali_media_restore_probe.py}"
ctr=""
pass=""

cleanup() {
  unset pass
  if [[ -n "$ctr" ]]; then
    docker rm --force "$ctr" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

case "${1:-}" in
  --self-test)
    bash -n "$0"
    python3 "$HELPER" --self-test
    echo "KALI_ISOLATED_RESTORE_SELFTEST_PASS"
    exit 0
    ;;
  --run) ;;
  *) echo "Uso: bash kali_restore_backup_isolated.sh --run|--self-test" >&2; exit 2 ;;
esac

for binary in docker gpg sha256sum python3; do
  command -v "$binary" >/dev/null || { echo "FALTA_HERRAMIENTA: $binary"; exit 2; }
done
[[ -f "$HELPER" ]] || { echo "Falta el validador de media"; exit 2; }
[[ -d "$BACKUP" && ! -L "$BACKUP" ]] || { echo "Falta el backup cifrado esperado"; exit 2; }
for filename in postgresql.dump.gpg media.tar.gpg SHA256SUMS.txt; do
  [[ -f "$BACKUP/$filename" && ! -L "$BACKUP/$filename" ]] || {
    echo "Archivo del respaldo ausente: $filename"; exit 2;
  }
done
echo "Verificando huellas cifradas del respaldo (sin descifrar)..."
(cd "$BACKUP" && sha256sum --check SHA256SUMS.txt)
docker image inspect postgres:16-alpine >/dev/null || {
  echo "Falta imagen local postgres:16-alpine; se abortó SIN hacer pull."; exit 2;
}
echo "Creando PostgreSQL 16 temporal totalmente aislado de red y volúmenes..."
ctr="tala-restore-f203-$(python3 -c 'import secrets;print(secrets.token_hex(7))')"
docker run --detach --rm --pull never --network none \
  --name "$ctr" \
  --label talaeats.restore_fixture=yes \
  --memory 1g --cpus 1.5 \
  --tmpfs /var/lib/postgresql/data:rw,size=1g \
  --tmpfs /tmp:rw,size=128m \
  -e POSTGRES_USER=tala_restore_probe \
  -e POSTGRES_DB=tala_restore_probe \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  postgres:16-alpine >/dev/null

up=0
for i in {1..60}; do
  if docker exec "$ctr" pg_isready -U tala_restore_probe -d tala_restore_probe >/dev/null 2>&1; then
    up=1; break
  fi
  sleep 1
done
[[ "$up" == "1" ]] || { echo "PostgreSQL de prueba no inició"; exit 2; }
echo "Contenedor temporal listo. No usa el Postgres de producción."

[[ -r /dev/tty ]] || { echo "Se requiere la terminal de Kali para ingresar la clave"; exit 2; }
IFS= read -r -s -p "Contraseña LOCAL del respaldo GPG (no aparece en pantalla): " pass < /dev/tty
printf '\n'
[[ -n "$pass" ]] || { echo "Contraseña vacía: abortado"; exit 2; }

echo "Restaurando dump en PostgreSQL temporal..."
gpg --batch --yes --quiet --no-symkey-cache --pinentry-mode loopback \
  --passphrase-fd 3 --decrypt "$BACKUP/postgresql.dump.gpg" 3<<<"$pass" | \
  docker exec -i "$ctr" pg_restore --exit-on-error --no-owner --no-acl \
    -U tala_restore_probe -d tala_restore_probe

version="$(docker exec "$ctr" psql -X -qAt -v ON_ERROR_STOP=1 \
  -U tala_restore_probe -d tala_restore_probe \
  -c 'SELECT version_num FROM public.alembic_version')"
[[ "$version" == "f21i00000001" ]] || {
  echo "Restore no coincide con Alembic esperado"; exit 2;
}
tables="$(docker exec "$ctr" psql -X -qAt -v ON_ERROR_STOP=1 \
  -U tala_restore_probe -d tala_restore_probe \
  -c "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='public'")"
[[ "$tables" =~ ^[0-9]+$ && "$tables" -gt 10 ]] || {
  echo "Esquema restaurado incompleto"; exit 2;
}
ledger="$(docker exec "$ctr" psql -X -qAt -v ON_ERROR_STOP=1 \
  -U tala_restore_probe -d tala_restore_probe \
  -c "SELECT to_regclass('public.financial_ledger_entries') IS NOT NULL")"
[[ "$ledger" == "t" ]] || {
  echo "Falta tabla ledger financiera en backup"; exit 2;
}
echo "KALI_PG16_TEMP_RESTORE_PASS alembic=$version tables=$tables"

echo "Restaurando TAR de fotografías en carpeta temporal de Kali..."
gpg --batch --yes --quiet --no-symkey-cache --pinentry-mode loopback \
  --passphrase-fd 3 --decrypt "$BACKUP/media.tar.gpg" 3<<<"$pass" | \
  python3 "$HELPER"
unset pass

echo "KALI_REAL_BACKUP_ISOLATED_RESTORE_PASS"
echo "Los datos de ensayo serán destruidos al cerrar este proceso."
echo "NO se tocó la base de datos/productivo; copia fuera de Kali AÚN debe comprobarse."
