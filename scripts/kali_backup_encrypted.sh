#!/usr/bin/env bash
# TALA EATS / Kali — backup cifrado de PostgreSQL y medios, sin detener servicios.
# Uso: bash scripts/kali_backup_encrypted.sh --preflight | --backup | --self-test
# NO hace restores, no copia a Windows, no accede a Stripe ni lee .env.
set -euo pipefail
umask 077

DB_CONTAINER="talaeats-v3-db-1"
API_CONTAINER="talaeats-v3-backend-1"
API_READY="http://127.0.0.1:8082/api/v1/ready"
BACKUP_PARENT="$HOME/talaeats-backups"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'FALTA_HERRAMIENTA: %s\n' "$1" >&2
    exit 2
  }
}

preflight() {
  for tool in docker gpg tar sha256sum curl python3 mktemp; do require "$tool"; done
  local project state health name
  for name in "$DB_CONTAINER" "$API_CONTAINER"; do
    project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$name")"
    [[ "$project" == "talaeats-v3" ]] || { echo "ABORT: Compose inesperado"; return 2; }
    state="$(docker inspect -f '{{.State.Status}}' "$name")"
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}unknown{{end}}' "$name")"
    [[ "$state" == "running" && "$health" == "healthy" ]] || {
      echo "ABORT: contenedor fuera de servicio: $name"; return 2;
    }
  done
  docker exec "$DB_CONTAINER" sh -c '
    test -n "$POSTGRES_USER" && test -n "$POSTGRES_DB" &&
    psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT 1" |
    grep -qx 1
  ' || { echo "ABORT: PostgreSQL no responde"; return 2; }
  docker exec "$API_CONTAINER" test -d /app/media || {
    echo "ABORT: volumen de fotos no accesible"; return 2;
  }
  curl --fail --silent --show-error --max-time 12 "$API_READY" | python3 -c '
import json,sys
s=json.load(sys.stdin)
if s.get("ready") is not True or s.get("version")!="1.6.4-connect-selfservice-hf1" or \
        s.get("database") is not True or s.get("redis") is not True:
    raise SystemExit("ABORT: READY o versión inesperados")
' || return 2
  [[ -d "$BACKUP_PARENT" && ! -L "$BACKUP_PARENT" ]] || {
    echo "ABORT: carpeta de backups no existe o es un enlace"; return 2;
  }
  [[ -w "$BACKUP_PARENT" ]] || { echo "ABORT: carpeta de backups sin permisos"; return 2; }
  echo "KALI_BACKUP_PREFLIGHT_PASS"
  echo "PostgreSQL/media accesibles; no se ha generado ningún respaldo."
}

self_test() {
  [[ "$DB_CONTAINER" == "talaeats-v3-db-1" ]]
  [[ "$API_CONTAINER" == "talaeats-v3-backend-1" ]]
  [[ "$BACKUP_PARENT" == "$HOME/talaeats-backups" ]]
  echo "KALI_BACKUP_SCRIPT_SELFTEST_PASS"
}

backup() {
  preflight
  [[ -r /dev/tty ]] || {
    echo "ABORT: requiere terminal interactiva para clave de cifrado"; return 2;
  }
  local pass confirm destination db_file media_file
  printf '\nClave NUEVA para el backup (mínimo 16 caracteres, guarda copia fuera de Kali).\n'
  IFS= read -r -s -p "Clave de cifrado: " pass < /dev/tty
  printf '\n'
  IFS= read -r -s -p "Repite clave: " confirm < /dev/tty
  printf '\n'
  if [[ "$pass" != "$confirm" || $(printf '%s' "$pass" | wc -c) -lt 16 ]]; then
    unset pass confirm
    echo "ABORT: claves diferentes o menos de 16 caracteres; no se creó respaldo"
    return 2
  fi
  unset confirm

  # Directorio nuevo privado: nunca sobreescribir backups anteriores.
  destination="$(mktemp -d "$BACKUP_PARENT/$(date -u +%Y%m%dT%H%M%SZ)-encrypted.XXXXXXXX")"
  db_file="$destination/postgresql.dump.gpg"
  media_file="$destination/media.tar.gpg"
  echo "Iniciando backup cifrado en: $destination"

  # Flujo binario pg_dump -Fc -> gpg AES256. Nunca plaintext en el disco.
  # La clave va por FD3; no está en argv ni en variables exportadas.
  if ! docker exec "$DB_CONTAINER" sh -c \
    'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-acl' |
      gpg --batch --yes --quiet --no-symkey-cache --pinentry-mode loopback \
        --passphrase-fd 3 --cipher-algo AES256 --symmetric \
        --output "$db_file.part" 3<<<"$pass"; then
    unset pass
    echo "BACKUP_FAIL: dump o cifrado falló; NO copiar la carpeta" >&2
    return 2
  fi
  mv -- "$db_file.part" "$db_file"

  # El volumen de fotografías permanece activo: coherencia por revisar.
  if ! docker cp "$API_CONTAINER:/app/media" - |
      gpg --batch --yes --quiet --no-symkey-cache --pinentry-mode loopback \
        --passphrase-fd 3 --cipher-algo AES256 --symmetric \
        --output "$media_file.part" 3<<<"$pass"; then
    unset pass
    echo "BACKUP_FAIL: fotos no validadas; NO copiar la carpeta" >&2
    return 2
  fi
  mv -- "$media_file.part" "$media_file"

  # Confirmar descifrado y legibilidad de formato; NO restaura DB.
  echo "Verificando formato cifrado de PostgreSQL..."
  if ! gpg --batch --quiet --no-symkey-cache --pinentry-mode loopback \
      --passphrase-fd 3 --decrypt "$db_file" 3<<<"$pass" |
      docker exec -i "$DB_CONTAINER" pg_restore --list >/dev/null; then
    unset pass
    echo "BACKUP_FAIL: pg_restore no pudo leer dump cifrado" >&2
    return 2
  fi
  echo "Verificando formato cifrado de fotografías..."
  if ! gpg --batch --quiet --no-symkey-cache --pinentry-mode loopback \
      --passphrase-fd 3 --decrypt "$media_file" 3<<<"$pass" |
      tar -tf - >/dev/null; then
    unset pass
    echo "BACKUP_FAIL: tar no pudo leer las fotos cifradas" >&2
    return 2
  fi
  unset pass

  (
    cd "$destination"
    sha256sum postgresql.dump.gpg media.tar.gpg > SHA256SUMS.txt
    sha256sum --check --status SHA256SUMS.txt
  )
  printf '%s\n' \
    'Formato pg_dump y tar comprobado; RESTAURACIÓN INTEGRAL PENDIENTE.' \
    'Copia en Windows y verificación SHA256 también PENDIENTES.' \
    > "$destination/README-ESTADO.txt"

  echo "=== ARCHIVOS CIFRADOS ==="
  ls -lh "$destination"
  echo "KALI_BACKUP_ENCRYPTED_FORMAT_PASS"
  echo "Carpeta para WinSCP: $destination"
  echo "PENDIENTE: ensayo de restauración y copia externa."
}

case "$#" in
  1) ;;
  *) echo "USO: bash scripts/kali_backup_encrypted.sh --preflight|--backup|--self-test" >&2; exit 2 ;;
esac
case "$1" in
  --self-test) self_test ;;
  --preflight) preflight ;;
  --backup) backup ;;
  *) echo "USO: bash scripts/kali_backup_encrypted.sh --preflight|--backup|--self-test" >&2; exit 2 ;;
esac
