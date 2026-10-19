#!/usr/bin/env bash
# Read-only inventory for a dedicated Tala Eats PM2 staging VPS.
# This does NOT deploy, install, source secrets, start PM2 or modify services.
set -Eeuo pipefail
umask 077

issues=0
pass() { printf 'PASS %s\n' "$1"; }
pending() { printf 'PENDING %s\n' "$1"; issues=$((issues + 1)); }
has() {
  if command -v "$1" >/dev/null 2>&1; then pass "binary:$1"; else pending "binary:$1"; fi
}
printf 'TALA_PM2_STAGE_READONLY_PROBE_BEGIN\n'
for bin in python3.13 node pm2 git curl cloudflared pg_isready redis-cli; do
  has "$bin"
done

root="$HOME/tala-eats-pm2-stage"
if [[ -d "$root/.git" ]] && command -v git >/dev/null 2>&1; then
  branch="$(git -C "$root" branch --show-current 2>/dev/null || true)"
  if [[ "$branch" == main ]]; then pass "git:main"; else pending "git:branch-not-main"; fi
  if [[ -z "$(git -C "$root" status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
    pass "git:tracked-clean"
  else
    pending "git:tracked-modifications"
  fi
else
  pending "git:staging-checkout-unavailable"
fi

conf="$HOME/.config/talaeats-pm2-stage.env"
if [[ -f "$conf" && ! -L "$conf" ]]; then
  if [[ "$(stat -c %u "$conf")" == "$(id -u)" && "$(stat -c %a "$conf")" == 600 ]]; then
    pass "config:owner-and-mode-0600"
  else
    pending "config:invalid-permissions"
  fi
else
  pending "config:missing-or-symlink"
fi

if command -v pg_isready >/dev/null 2>&1 && pg_isready -q -h 127.0.0.1 -p 5432; then
  pass "postgresql:local-listener-ready"
else
  pending "postgresql:local-not-ready"
fi

if command -v redis-cli >/dev/null 2>&1 && [[ "$(redis-cli -h 127.0.0.1 -p 6379 -n 1 ping 2>/dev/null || true)" == PONG ]]; then
  pass "redis:local-db1-pong"
else
  pending "redis:local-db1-unavailable"
fi

if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet cloudflared.service; then
  pass "cloudflared:service-active"
else
  pending "cloudflared:service-not-confirmed"
fi

if command -v curl >/dev/null 2>&1 && command -v python3.13 >/dev/null 2>&1; then
  # Never print the response body or secret environment values.
  if curl -fsS --noproxy '*' --max-time 4 http://127.0.0.1:18090/api/v1/ready 2>/dev/null \
       | python3.13 -c 'import json,sys; d=json.load(sys.stdin); assert all(d.get(k) is True for k in ("ready","database","redis"))' 2>/dev/null; then
    pass "api:ready-database-redis"
  else
    pending "api:local-ready-unconfirmed"
  fi
fi

# Local socket presence does NOT prove GitHub Actions can reach public SSH.
printf 'UNVERIFIED github-actions-to-vps-ssh-external\n'
printf 'UNVERIFIED cloudflare-public-hostname-tls\n'
printf 'TALA_PM2_STAGE_READONLY_PROBE_END issues=%s\n' "$issues"
test "$issues" -eq 0
