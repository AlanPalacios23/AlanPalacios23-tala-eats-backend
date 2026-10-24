# TALA EATS RC8.13 — Kali parallel STAGING without touching active LIVE RC8.6

## Current confirmed facts — Kali 24 October 2026

- LIVE is on **127.0.0.1:18190**, served by `tala-node-stage-api` /
  `tala-node-stage-worker` **but reports `production=true` and
  `online_payment_writes=true`**. Their misleading names do not make
  them staging. They run commit `fbacabaae34e6dea8718aa6ced648431248dfbab`.
- Separate unused staging resources are **PG15** `127.0.0.1:15435/tala_node_stage`
  and Redis8 `127.0.0.1:16379/0`; do NOT modify active production process.
- RC8.12 staging gates passed 203/203 tests, but former rollout checks
  correctly returned `ABORT_STAGE_NOT_READY` against the LIVE service.
- Cloudflared sends public TALA EATS domain to LIVE 18190, and paths
  `/privacidad` and `/eliminar-cuenta` to the separate 18191 origin.

## RC8.13 approach

- NEW private API: `127.0.0.1:18192` (no public Cloudflare route).
- NEW separate PM2 daemon: `/home/tala-node-stage/.pm2-tala-rc813-parallel`.
  Names `tala-rc813-parallel-worker` and `tala-rc813-parallel-api`.
  Default PM2 processes live on; the new runner NEVER addresses them.
- PostgreSQL ONLY stage `tala_node_stage`, loopback PG15 15435.
- Redis8 port 16379 but **DB1** (`/1`), separate from previous stage DB0.
- Private new environment `~/.config/talaeats-node-rc813-parallel.env`
  generated from prior known staging env, permissions 0600. The generator
  does not rewrite the original.
- New mode enabled only with `STAGE_PARALLEL_ENABLED=true`,
  `NODE_ENV=staging`, `PORT=18192`, and stage Redis DB1.
- Stripe LIVE, manual settlement, Connect transfer, Stripe TEST charging
  flags must be OFF. No requests to Stripe LIVE are made by the installer.
- No database migration or schema changes performed by this procedure.
- Do not connect live apps/users to the private staging API.

## Steps as tala-node-stage on Kali

From the existing shell:

```bash
sudo -iu tala-node-stage
```

Use the FINAL approved SHA of the RC8.13 branch. Do not paste a moving
branch and accept a different SHA. Execute:

```bash
SHA="<RC813_FINAL_40_HEX_SHA>"
BRANCH="fix/rc813-parallel-kali-stage-20261024"
ROOT="$HOME/tala-node-releases/$SHA"
test ! -e "$ROOT"
git clone --depth 1 --branch "$BRANCH" \
  https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend.git \
  "$ROOT"
test "$(git -C "$ROOT" rev-parse HEAD)" = "$SHA"
cd "$ROOT/node-backend"
```

### 1 — stage env derivation, private

```bash
python3 scripts/rc813-create-parallel-stage-env.py --plan
python3 scripts/rc813-create-parallel-stage-env.py --create
```

The new file is created **once**. If it already exists, the generator
intentionally refuses overwrite. Do not paste it in chat or edit existing
production PM2 environment files.

### 2 — prepare and plan

```bash
bash scripts/rc813-parallel-stage.sh --prepare "$SHA"
bash scripts/rc813-parallel-stage.sh --plan "$SHA"
```

Both steps leave PM2 and the existing DB schema untouched. The plan:
- validates file owner/mode, exact immutable Git SHA, Node24/Prisma build;
- verifies LIVE continues to answer `/health` on 18190 (read-only);
- checks stage env points ONLY to PG15 15435 and Redis8 DB1;
- checks `prisma migrate status` on stage and **fails if anything is pending**
  (never `migrate deploy`);
- refuses if port 18192 is taken, new PM2 home already exists, or Redis DB1
  already has keys.

A HOLD is not an invitation to change production credentials or disable
the checks. Investigate; do not execute `--apply` until solved.

### 3 — Start independent staging API and worker

Only after both commands print PASS:

```bash
bash scripts/rc813-parallel-stage.sh --apply "$SHA" I_APPROVE_RC813_PARALLEL_STAGE_ONLY
```

Starts a **new** PM2 daemon, starts its worker first, confirms heartbeat in
staging Redis DB1, then starts its API and confirms `/ready` HTTP 200.
On failure, it attempts to delete only the two *new* process names and stop
the isolated PM2 daemon. It never calls default PM2 and never reconfigures
Cloudflared. The stage Redis DB1 may have transient worker data.

**Persistence:** PM2 dump is saved under its isolated PM2_HOME, but boot
autostart is deliberately NOT configured. After reboot, use a dedicated
reviewed startup unit; NEVER change the existing public production unit.

### 4 — Verify without financial writes

```bash
bash scripts/rc813-parallel-stage.sh --verify "$SHA"
curl -sS -o /dev/null -w 'RC813_LOCAL %{http_code} %{content_type}\n' \
  http://127.0.0.1:18192/api/v1/ready
curl -sS -o /dev/null -w 'LIVE_UNCHANGED %{http_code} %{content_type}\n' \
  http://127.0.0.1:18190/api/v1/ready
curl -sS -o /dev/null -w 'PRIVACIDAD %{http_code} %{content_type}\n' \
  https://talaeats.alan-palacios-dev.com/privacidad
curl -sS -o /dev/null -w 'BORRAR_CUENTA %{http_code} %{content_type}\n' \
  https://talaeats.alan-palacios-dev.com/eliminar-cuenta
```

**Expected RC813:** `environment=staging`, `financialWrites=false`,
`onlinePaymentsEnabled=false`, workerOnline=true, API only on loopback 18192.

**Expected existing LIVE:** public `production=true` and existing
availability must remain unchanged. Do not infer financial safety of LIVE
from the new stage test suite.

## After deployment — staged workflow testing

1. API identity and read-only catalog/restaurant, quote, auth/authorization.
2. Separate test users/store/driver, no real checkout; test setup and seeded
   records only in PostgreSQL stage 15435.
3. Synthetic cash order → restaurant → driver GPS/READY → PIN → ledger,
   with exact idempotency and stock rollback tests.
4. Stripe TEST payment only after separate explicit enablement and signed
   webhook verification, never LIVE.
5. Firebase and Flutter device compatibility after server-only proof.

Live charge activation, commercial release, and Connect are **out of scope**.
