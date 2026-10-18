# TALA EATS — Kali pull-agent staging

**Architecture:** The GitHub repository remains public. GitHub-hosted runners do the CI. A non-root, dedicated Kali Linux account later runs a small OUTBOUND HTTPS poller with no GitHub credential, inbound SSH or self-hosted runner. The pull agent only targets PM2 STAGING, never the existing Docker LIVE services, Stripe, Caddy, photos or production databases.

**No deployment today:** This PR only supplies code. Kali has not been accessed or configured. Existing HTTP 502 must be investigated separately. The PM2 staging services need an independent Linux account, PostgreSQL cluster and Redis instance on Kali; do NOT assume production port 5432, Redis port 6379/DB 1 or current Docker storage are safe to reuse. Inspect using the read-only diagnostics before selecting final staging ports.

**Approval protocol:** Work through PR -> review -> merge to main -> all 8 CI checks PASS. The owner opens Actions / TALA EATS | Approve Kali staging deployment (no SSH) / Run workflow / main / APPROVE_STAGE. This manual workflow only marks an approved commit by a successful workflow run after checking the eight GitHub CI jobs; it never SSHes to Kali. A dedicated user agent on Kali polls GitHub's public API over HTTPS, validates owner, main SHA, successful manual run no older than 4 hours, checks every CI result again, and invokes the staging deployment script only after an extra local opt-in.

**Local opt-in is disabled by default:** A private local 0600 JSON file under the stage user's home config named talaeats-kali-stage-agent.json must contain exactly {"enable_staging_deploy": true}. Without that file, even --apply does nothing. No secrets or GitHub tokens are required. Last approval run ID is recorded locally before staging deployment so failures do not auto-retry; owner must issue a fresh manual approval.

**Initial installation:** Once an authorized person can log into Kali: read-only inventory; reserve separate staging ports; install Python3.13, Node/PM2, isolated PG/Redis (without modifying existing); create unprivileged stage Linux account with no sudo, no Docker group and no production filesystem access; clone the public repo via HTTPS into its independent stage HOME; configure staging secrets strictly on host with chmod 600; validate staging guards and manual migration on its isolated DB. Only then install a systemd user timer that invokes Python3 <HOME>/tala-eats-pm2-stage/scripts/kali_stage_pull_agent.py --apply about every ten minutes. Verify isolation and rollback under human supervision before creating the opt-in JSON. No GitHub Actions self-hosted runner is installed. No automatic LIVE deployment is implemented.

**Not yet done:** No SSH access to Kali exists from this conversation, no initial installation, no tunnel modifications, no auto-deploy enabled. The obsolete SSH deployment workflow was removed from PR #79. No VPS/Tailscale or GitHub SSH secrets are required for the pull-agent design.

## User-level systemd templates (STAGING ONLY; after Kali access and resource audit)

The repository includes deploy/pm2/talaeats-kali-stage-agent.service and deploy/pm2/talaeats-kali-stage-agent.timer. The stage-only non-root Linux user can install them after the staging checkout, isolated PG and Redis are validated.

From the staging user account, and NOT the production alan user:

~~~bash
mkdir -p ~/.config/systemd/user
cp ~/tala-eats-pm2-stage/deploy/pm2/talaeats-kali-stage-agent.service ~/.config/systemd/user/
cp ~/tala-eats-pm2-stage/deploy/pm2/talaeats-kali-stage-agent.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now talaeats-kali-stage-agent.timer
systemctl --user list-timers
~~~

This timer polls outbound about every 10 minutes; it is NOT a GitHub Actions runner. The local 0600 JSON opt-in MUST remain absent until a supervised staging-only test and verified rollback. Once ready, the dedicated stage user (not root) can create the opt-in file; never store the staging DB/JWT secrets in GitHub.

A denied manual approval (wrong actor, branch or NO) MUST result in a failed GitHub Actions job. Any staging deployment approval should be granted only after reviewing the PR and all EIGHT green CI checks on the exact main SHA. In addition to the previous seven checks, the independent 20-case outbound-agent security test must also PASS.

### Remaining blockers

- Kali still has no authorized SSH execution channel in this ChatGPT session; installation cannot be performed simply by adding files to GitHub.
- Public endpoint talaeats.alan-palacios-dev.com/api/v1/health returned HTTP 502 on repeated checks, so verify production health before any release.
- On the shared Kali host, the existing stage guard's current localhost DB/Redis defaults are NOT sufficient evidence of isolation. Audit running production sockets and create separate native instances / update stage guard and CI accordingly before setting enable_staging_deploy=true.
- The existing Docker production backend and Stripe LIVE remain unchanged. Production release automation is a different, later project requiring explicit approval and recovery testing.
