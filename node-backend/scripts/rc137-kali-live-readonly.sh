#!/usr/bin/env bash
# RC13.7 Kali read-only live gate. Does NOT deploy or authorize money movement.
set -uo pipefail
fail=0
check() { local label="$1"; shift; if "$@" >/dev/null 2>&1; then printf '%s=PASS\n' "$label"; else printf '%s=HOLD\n' "$label"; fail=1; fi; }
echo "RC137_MODE=READ_ONLY"
echo "RC137_STRIPE_WRITES=ZERO"
echo "RC137_SQL_WRITES=ZERO"
check RC137_CURL_INSTALLED command -v curl
check RC137_GIT_INSTALLED command -v git
check RC137_NODE_INSTALLED command -v node
check RC137_PM2_INSTALLED command -v pm2
check RC137_API_READY_HTTP curl -fsS --connect-timeout 3 --max-time 8 http://127.0.0.1:18190/api/v1/ready
check RC137_API_HEALTH_HTTP curl -fsS --connect-timeout 3 --max-time 8 http://127.0.0.1:18190/api/v1/health
if command -v pm2 >/dev/null 2>&1; then
  # Only PM2's own status fields; never print env, tokens or process arguments.
  if pm2 jlist 2>/dev/null | node -e '
  let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{
  try {const v=JSON.parse(s);const active=v.filter(x=>x.pm2_env?.status==="online");
  process.exit(active.length>=2?0:1)}catch{process.exit(1)}})' ; then
    echo "RC137_PM2_TWO_ONLINE=PASS"
  else echo "RC137_PM2_TWO_ONLINE=HOLD";fail=1;fi
fi
for service in talaeats-clientes talaeats-restaurantes talaeats-repartidores;do
  if systemctl is-active --quiet "$service" 2>/dev/null; then
     echo "RC137_SYSTEMD_${service}=PASS"
  else
     echo "RC137_SYSTEMD_${service}=NOT_VERIFIED"
  fi
done
# External endpoints are checked for availability only; a 200 is not proof of financial correctness.
for host in web-talaeats.alan-palacios-dev.com restaurantes-talaeats.alan-palacios-dev.com repartidores-talaeats.alan-palacios-dev.com;do
 if curl -fsS --connect-timeout 4 --max-time 10 -o /dev/null "https://$host/" ;then
   echo "RC137_PUBLIC_${host}=PASS"
 else echo "RC137_PUBLIC_${host}=HOLD";fail=1;fi
done
echo "RC137_STRIPE_TEST_PAYMENT=UNVERIFIED"
echo "RC137_STRIPE_PROVIDER_RECONCILIATION=UNVERIFIED"
echo "RC137_BACKUP_RESTORE=UNVERIFIED"
echo "RC137_RELEASE_SHA=UNVERIFIED"
echo "RC137_LIVE_FINANCIAL_FLAGS=NOT_INSPECTED"
echo "RC137_COMMERCIAL_GO=NOT_AUTHORIZED"
if ((fail));then echo "RC137_INFRA_READONLY=HOLD"; exit 2;fi
echo "RC137_INFRA_REACHABILITY=PASS_NOT_LAUNCH_AUTHORIZATION"
