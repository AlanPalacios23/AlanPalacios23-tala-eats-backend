#!/bin/sh
# Explicit operator-approved production migration. NEVER run on API startup.
set -eu
refuse() {
  printf '%s\n' "[Tala Eats] MIGRATION REFUSED: $1" >&2
  exit 78
}
environment_normalized=$(printf '%s' "\${ENVIRONMENT:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
[ "$environment_normalized" = "production" ] || refuse "ENVIRONMENT must be production"
[ "\${TALA_MIGRATION_APPROVED:-}" = "YES-I-APPROVE-PRODUCTION-MIGRATION" ] || refuse "explicit approval missing"
[ "\${TALA_RESTORE_VERIFIED:-}" = "YES" ] || refuse "isolated backup restore proof missing"
[ -n "\${TALA_CHANGE_TICKET:-}" ] || refuse "change ticket missing"
case "\${DATABASE_URL:-}" in
  postgresql+psycopg://*|postgresql://*) ;;
  *) refuse "production PostgreSQL required" ;;
esac
release_sha=\${TALA_APPROVED_RELEASE_SHA:-}
case "$release_sha" in
  *[!0123456789abcdef]*|"") refuse "approved SHA must be lowercase hexadecimal" ;;
esac
[ "\${#release_sha}" -eq 40 ] || refuse "approved SHA must be 40 characters"
backup_file=\${TALA_APPROVED_BACKUP_FILE:-}
[ -n "$backup_file" ] && [ -f "$backup_file" ] && [ -s "$backup_file" ] ||
  refuse "nonempty verified backup file required"
expected_digest=\${TALA_BACKUP_SHA256:-}
case "$expected_digest" in
  *[!0123456789abcdef]*|"") refuse "backup SHA256 missing or invalid" ;;
esac
[ "\${#expected_digest}" -eq 64 ] || refuse "backup SHA256 must be 64 characters"
actual_digest=$(sha256sum "$backup_file" | cut -d ' ' -f 1)
[ "$expected_digest" = "$actual_digest" ] || refuse "backup SHA256 mismatch"
script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
observed_sha=$(git -C "$repo_root" rev-parse HEAD 2>/dev/null) ||
  refuse "pinned repository checkout required"
[ "$observed_sha" = "$release_sha" ] || refuse "checkout SHA differs from approved release"
# Deliberately does not output connection string, passwords or tokens.
printf '%s\n' "[Tala Eats] Approved migration for SHA $release_sha and ticket $TALA_CHANGE_TICKET"
printf '%s\n' "[Tala Eats] Backup digest verified and restored snapshot attested"
exec python -m alembic upgrade head
