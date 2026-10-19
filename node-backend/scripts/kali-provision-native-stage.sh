#!/usr/bin/env bash
# TALA EATS native PG15+Redis staging only. No Docker, no apt installs.
# Default --plan is read-only. --apply requires root and exact opt-in flag.
set -euo pipefail
umask 077
MODE="--plan"
if [ "$#" -gt 0 ]; then MODE="$1"; fi
if [ "$MODE" != "--plan" ] && [ "$MODE" != "--apply" ]; then
  echo 'USAGE --plan|--apply'; exit 2
fi
LINUX_USER='tala-node-stage'
PG_CLUSTER='tala_node_stage'
REDIS_UNIT='tala-node-stage-redis'
REDIS_DIR='/var/lib/tala-node-stage/redis'
REDIS_CONF='/etc/tala-node-stage/redis.conf'
ENV_PATH='/home/tala-node-stage/.config/talaeats-node-staging.env'
exists_port() { ss -H -ltn | awk '{print $4}' | grep -Eq ":$1$"; }
cluster_exists() { pg_lsclusters --no-header 2>/dev/null | awk '$1=="15" && $2=="tala_node_stage" {f=1} END {exit !f}'; }

echo 'TALA_NATIVE_STAGE_PROVISION_BEGIN'
for tool in pg_createcluster pg_ctlcluster pg_conftool pg_lsclusters redis-server redis-cli openssl ss runuser systemctl; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "BIN_$tool=present"
  else
    echo "BIN_$tool=missing"
  fi
done
if command -v ss >/dev/null 2>&1; then
  for port in 15435 16379 18190; do
    if exists_port "$port"; then
      echo "PORT_$port=occupied"
    else
      echo "PORT_$port=free"
    fi
  done
fi
if getent passwd "$LINUX_USER" >/dev/null; then
  echo 'STAGE_ACCOUNT=already_exists'
else
  echo 'STAGE_ACCOUNT=not_created'
fi
if command -v pg_lsclusters >/dev/null 2>&1 && cluster_exists; then
  echo 'PG15_STAGE_CLUSTER=already_exists'
else
  echo 'PG15_STAGE_CLUSTER=not_created'
fi
if [ "$MODE" = "--plan" ]; then
  echo 'PLAN_ONLY_NO_MUTATIONS'
  echo 'TALA_NATIVE_STAGE_PROVISION_END'
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then echo 'ABORT_ROOT_REQUIRED'; exit 1; fi
if [ "$(printenv TALA_NATIVE_STAGE_APPROVAL 2>/dev/null || true)" != 'I_APPROVE_NEW_NATIVE_STAGE_ONLY' ]; then
  echo 'ABORT_EXPLICIT_APPROVAL_REQUIRED'; exit 1
fi
for tool in pg_createcluster pg_ctlcluster pg_conftool pg_lsclusters redis-server redis-cli openssl ss runuser systemctl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ABORT_DEPENDENCY_MISSING_$tool"; exit 1; }
done
if [ ! -x /usr/lib/postgresql/15/bin/postgres ]; then
  echo 'ABORT_POSTGRESQL15_NOT_INSTALLED'; exit 1
fi
if [ ! -d /run/systemd/system ]; then
  echo 'ABORT_SYSTEMD_REQUIRED'; exit 1
fi
for port in 15435 16379 18190; do
  if exists_port "$port"; then echo "ABORT_PORT_$port_IN_USE"; exit 1; fi
done
if cluster_exists; then echo 'ABORT_STAGE_CLUSTER_ALREADY_EXISTS'; exit 1; fi
if getent passwd "$LINUX_USER" >/dev/null; then echo 'ABORT_STAGE_USER_ALREADY_EXISTS'; exit 1; fi
if [ -e "$REDIS_CONF" ] || [ -e "$ENV_PATH" ] ||
   [ -e "/etc/systemd/system/$REDIS_UNIT.service" ]; then
  echo 'ABORT_PREEXISTING_STAGE_CONFIG'; exit 1
fi

# No apt execution; package installation must be approved separately.
useradd --create-home --home-dir /home/tala-node-stage --shell /bin/bash "$LINUX_USER"
install -d -m 0700 -o "$LINUX_USER" -g "$LINUX_USER" /home/tala-node-stage/.config
install -d -m 0750 -o root -g "$LINUX_USER" /etc/tala-node-stage
install -d -m 0700 -o "$LINUX_USER" -g "$LINUX_USER" "$REDIS_DIR"

pg_createcluster 15 "$PG_CLUSTER" --port 15435 --start-conf=manual >/dev/null
pg_conftool 15 "$PG_CLUSTER" set listen_addresses '127.0.0.1'
pg_conftool 15 "$PG_CLUSTER" set password_encryption 'scram-sha-256'
pg_ctlcluster 15 "$PG_CLUSTER" start >/dev/null

PG_PASS="$(openssl rand -hex 32)"
REDIS_PASS="$(openssl rand -hex 32)"
# Password enters psql through stdin only; never as process arguments.
printf "CREATE ROLE tala_node_stage LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;\n" "$PG_PASS" |
  runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -p 15435 -d postgres >/dev/null 2>&1
printf '%s\n' 'CREATE DATABASE tala_node_stage OWNER tala_node_stage;' |
  runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -p 15435 -d postgres >/dev/null 2>&1

cat > "$REDIS_CONF" <<REDIS
bind 127.0.0.1
port 16379
protected-mode yes
requirepass $REDIS_PASS
daemonize no
supervised no
dir $REDIS_DIR
appendonly yes
maxmemory 96mb
maxmemory-policy noeviction
logfile ""
REDIS
chown root:"$LINUX_USER" "$REDIS_CONF"
chmod 0640 "$REDIS_CONF"

cat > "/etc/systemd/system/$REDIS_UNIT.service" <<UNIT
[Unit]
Description=TALA EATS Native Staging Redis (port 16379)
After=network.target
[Service]
Type=simple
User=tala-node-stage
Group=tala-node-stage
ExecStart=/usr/bin/redis-server $REDIS_CONF
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$REDIS_DIR
[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 "/etc/systemd/system/$REDIS_UNIT.service"
systemctl daemon-reload
systemctl enable --now "$REDIS_UNIT" >/dev/null

cat > "$ENV_PATH" <<ENV
NODE_ENV=staging
HOST=127.0.0.1
PORT=18190
DATABASE_URL=postgresql://tala_node_stage:$PG_PASS@127.0.0.1:15435/tala_node_stage
REDIS_URL=redis://:$REDIS_PASS@127.0.0.1:16379/0
STRIPE_FINANCIAL_WRITES_ENABLED=false
ENV
chown "$LINUX_USER":"$LINUX_USER" "$ENV_PATH"
chmod 0600 "$ENV_PATH"

if PGPASSWORD="$PG_PASS" psql -X -q -t -A -h 127.0.0.1 -p 15435 \
  -U tala_node_stage -d tala_node_stage -c 'SELECT 1' 2>/dev/null | grep -qx 1; then
  echo 'NATIVE_PG15_STAGE_AUTH=PASS'
else
  echo 'NATIVE_PG15_STAGE_AUTH=FAIL'; exit 1
fi
if REDISCLI_AUTH="$REDIS_PASS" redis-cli -h 127.0.0.1 -p 16379 ping 2>/dev/null | grep -qx PONG; then
  echo 'NATIVE_REDIS_STAGE_AUTH=PASS'
else
  echo 'NATIVE_REDIS_STAGE_AUTH=FAIL'; exit 1
fi
echo 'NATIVE_STAGE_USER_CREATED=yes'
echo 'NATIVE_STAGE_PRIVATE_ENV_CREATED=yes'
echo 'NATIVE_STAGE_ISOLATION_READY=yes'
echo 'NO_DOCKER_NO_FINANCIAL_CHANGES=yes'
echo 'TALA_NATIVE_STAGE_PROVISION_END'
