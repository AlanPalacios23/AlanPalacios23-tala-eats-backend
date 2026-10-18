#!/usr/bin/env python3
"""Disposable PM2 staging regression tests: no network, SSH or database."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SHA = "a" * 40

def executable(path, data):
    path.write_text(data)
    path.chmod(0o700)

class StageTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="tala-pm2-qa-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.home = self.root / "home"
        self.repo = self.home / "tala-eats-pm2-stage"
        self.bin = self.root / "fake-bin"
        self.state = self.root / "state"
        self.config = self.home / ".config/talaeats-pm2-stage.env"
        for p in (self.repo / "scripts", self.repo / "deploy/pm2", self.repo / "backend",
                  self.bin, self.state, self.config.parent, self.home / "talaeats-stage-media"):
            p.mkdir(parents=True, exist_ok=True)
        for src in ("scripts/deploy_pm2_stage.sh", "deploy/pm2/validate-stage.sh",
                    "deploy/pm2/run-python.sh"):
            target = self.repo / src
            shutil.copy2(ROOT / src, target)
        (self.repo / "backend/requirements.txt").write_text("# disposable fixture\n")
        self.env = dict(os.environ, HOME=str(self.home), REAL_PYTHON=sys.executable,
                        MOCK_STATE=str(self.state), MOCK_REMOTE_SHA=SHA,
                        PATH=str(self.bin) + os.pathsep + os.environ["PATH"])
        self.write_config()
        self.make_fakes()

    def write_config(self, **kwargs):
        data = dict(ENVIRONMENT="production", DEBUG="false",
                    DATABASE_URL="postgresql+psycopg://fake:fake@127.0.0.1:5432/talaeats_stage",
                    REDIS_URL="redis://127.0.0.1:6379/1",
                    MEDIA_DIR=str(self.home / "talaeats-stage-media"),
                    JWT_SECRET="test-only-" + "x" * 50,
                    STRIPE_ENABLED="false", WITHDRAWALS_EXECUTION_ENABLED="false",
                    SEED_DEMO_DATA="false", AUTO_MIGRATE_ON_START="false")
        data.update(kwargs)
        self.config.write_text("".join(f"{k}={v}\n" for k, v in data.items()))
        self.config.chmod(0o600)

    def make_fakes(self):
        executable(self.bin / "git", r'''#!/bin/bash
echo "git $*" >> "$MOCK_STATE/actions"
case "$1" in
 branch) echo "${MOCK_BRANCH:-main}";;
 status) if [[ -n "${MOCK_DIRTY:-}" ]]; then echo ' M mock-file'; fi;;
 rev-parse)
   if [[ "$2" == FETCH_HEAD ]]; then echo "$MOCK_REMOTE_SHA"
   elif [[ "$2" == HEAD && -e "$MOCK_STATE/pulled" ]]; then echo "$MOCK_REMOTE_SHA"
   else echo bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; fi;;
 fetch) :;;
 merge-base) [[ -z "${MOCK_DIVERGED:-}" ]];;
 pull) touch "$MOCK_STATE/pulled";;
 *) exit 3;;
esac
''')
        executable(self.bin / "python3.13", r'''#!/bin/bash
if [[ "$1" == "-m" && "$2" == venv ]]; then
 mkdir -p "$3/bin"
 cat > "$3/bin/python" <<'PYMOCK'
#!/bin/bash
echo "python $*" >> "$MOCK_STATE/actions"
exit 0
PYMOCK
 cat > "$3/bin/alembic" <<'MIGMOCK'
#!/bin/bash
echo "alembic $*" >> "$MOCK_STATE/actions"
[[ -z "${MOCK_ALEMBIC_FAIL:-}" ]]
MIGMOCK
 chmod 700 "$3/bin/python" "$3/bin/alembic"
 exit 0
fi
exec "$REAL_PYTHON" "$@"
''')
        executable(self.bin / "pm2", r'''#!/bin/bash
echo "pm2 $*" >> "$MOCK_STATE/actions"
if [[ "$1" == restart ]]; then
 [[ -z "${MOCK_RESTART_FAIL:-}" ]]
elif [[ "$1" == jlist ]]; then
 if [[ -n "${MOCK_WORKER_FAIL:-}" ]]; then
   echo '[{"name":"talaeats-pm2-api-stage","pm2_env":{"status":"online"}},{"name":"talaeats-pm2-worker-stage","pm2_env":{"status":"errored"}}]'
 else
   echo '[{"name":"talaeats-pm2-api-stage","pm2_env":{"status":"online"}},{"name":"talaeats-pm2-worker-stage","pm2_env":{"status":"online"}}]'
 fi
else exit 3; fi
''')
        executable(self.bin / "curl", r'''#!/bin/bash
echo "curl $*" >> "$MOCK_STATE/actions"
if [[ -n "${MOCK_UNHEALTHY:-}" ]]; then
 echo '{"ready":true,"database":false,"redis":true}'
else
 echo '{"ready":true,"database":true,"redis":true}'
fi
''')
        executable(self.bin / "sleep", "#!/bin/sh\nexit 0\n")
        (self.repo / "backend/.venv/bin").mkdir(parents=True)
        executable(self.repo / "backend/.venv/bin/python",
                   '#!/bin/bash\necho "python $*" >> "$MOCK_STATE/actions"\nexit 0\n')

    def run_script(self, file, *args):
        return subprocess.run(["bash", str(self.repo / file), *args],
                              cwd=(self.repo / "backend" if str(file).endswith("run-python.sh") else self.repo),
                              env=self.env, text=True,
                              capture_output=True, timeout=20)

    def log(self):
        f = self.state / "actions"
        return f.read_text() if f.exists() else ""

    def check_guard_rejected(self, **overrides):
        self.write_config(**overrides)
        r = self.run_script("deploy/pm2/validate-stage.sh")
        self.assertNotEqual(r.returncode, 0, (r.stdout, r.stderr))

    def test_01_guard_valid(self):
        r = self.run_script("deploy/pm2/validate-stage.sh")
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_02_guard_missing_file(self):
        self.config.unlink()
        self.assertEqual(self.run_script("deploy/pm2/validate-stage.sh").returncode, 78)

    def test_03_guard_symlink_file(self):
        dest = self.home / "secret.test"
        dest.write_text(self.config.read_text())
        self.config.unlink()
        self.config.symlink_to(dest)
        self.assertEqual(self.run_script("deploy/pm2/validate-stage.sh").returncode, 78)

    def test_04_guard_permissions(self):
        self.config.chmod(0o644)
        self.assertEqual(self.run_script("deploy/pm2/validate-stage.sh").returncode, 78)

    def test_05_guard_dev_mode(self):
        self.check_guard_rejected(ENVIRONMENT="development")

    def test_06_guard_debug(self):
        self.check_guard_rejected(DEBUG="true")

    def test_07_guard_stripe(self):
        self.check_guard_rejected(STRIPE_ENABLED="true")

    def test_08_guard_stripe_key(self):
        self.check_guard_rejected(STRIPE_SECRET_KEY="fake-not-a-real-key")

    def test_09_guard_payout(self):
        self.check_guard_rejected(WITHDRAWALS_LIVE_ENABLED="true")

    def test_10_guard_migrate(self):
        self.check_guard_rejected(AUTO_MIGRATE_ON_START="true")

    def test_11_guard_demo_seed(self):
        self.check_guard_rejected(SEED_DEMO_DATA="true")

    def test_12_guard_remote_pg(self):
        self.check_guard_rejected(DATABASE_URL="postgresql+psycopg://x:y@outside.example/talaeats_stage")

    def test_13_guard_wrong_pg_name(self):
        self.check_guard_rejected(DATABASE_URL="postgresql+psycopg://x:y@127.0.0.1:5432/production")

    def test_14_guard_remote_redis(self):
        self.check_guard_rejected(REDIS_URL="redis://outside.example:6379/1")

    def test_15_guard_wrong_redis_db(self):
        self.check_guard_rejected(REDIS_URL="redis://127.0.0.1:6379/0")

    def test_16_guard_media(self):
        self.check_guard_rejected(MEDIA_DIR=str(self.home / "production-media"))

    def test_17_deploy_invalid_sha(self):
        r = self.run_script("scripts/deploy_pm2_stage.sh", "main")
        self.assertNotEqual(r.returncode, 0)
        self.assertNotIn("git ", self.log())

    def test_18_deploy_dirty_checkout(self):
        self.env["MOCK_DIRTY"] = "yes"
        self.assertNotEqual(self.run_script("scripts/deploy_pm2_stage.sh", SHA).returncode, 0)
        self.assertNotIn("git pull", self.log())

    def test_19_deploy_wrong_branch(self):
        self.env["MOCK_BRANCH"] = "other"
        self.assertNotEqual(self.run_script("scripts/deploy_pm2_stage.sh", SHA).returncode, 0)
        self.assertNotIn("git pull", self.log())

    def test_20_deploy_stale_SHA(self):
        self.env["MOCK_REMOTE_SHA"] = "c" * 40
        self.assertNotEqual(self.run_script("scripts/deploy_pm2_stage.sh", SHA).returncode, 0)
        self.assertNotIn("git pull", self.log())

    def test_21_deploy_diverged(self):
        self.env["MOCK_DIVERGED"] = "yes"
        self.assertNotEqual(self.run_script("scripts/deploy_pm2_stage.sh", SHA).returncode, 0)
        self.assertNotIn("git pull", self.log())

    def test_22_deploy_finance_blocks_before_git_pull(self):
        self.write_config(STRIPE_CONNECT_ENABLED="true")
        self.assertNotEqual(self.run_script("scripts/deploy_pm2_stage.sh", SHA).returncode, 0)
        self.assertNotIn("git pull", self.log())

    def test_23_deploy_alembic_guard(self):
        self.env["MOCK_ALEMBIC_FAIL"] = "yes"
        r = self.run_script("scripts/deploy_pm2_stage.sh", SHA)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("MIGRATION_GATE_BLOCKED", r.stderr)
        self.assertNotIn("pm2 restart", self.log())

    def test_24_deploy_pm2_failure(self):
        self.env["MOCK_RESTART_FAIL"] = "yes"
        self.assertNotEqual(self.run_script("scripts/deploy_pm2_stage.sh", SHA).returncode, 0)
        self.assertIn("pm2 restart", self.log())

    def test_25_deploy_unhealthy_db(self):
        self.env["MOCK_UNHEALTHY"] = "yes"
        r = self.run_script("scripts/deploy_pm2_stage.sh", SHA)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("PM2_STAGE_HEALTH_FAIL", r.stderr)

    def test_26_deploy_offline_worker(self):
        self.env["MOCK_WORKER_FAIL"] = "yes"
        self.assertNotEqual(self.run_script("scripts/deploy_pm2_stage.sh", SHA).returncode, 0)

    def test_27_deploy_success(self):
        r = self.run_script("scripts/deploy_pm2_stage.sh", SHA)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("PM2_STAGE_DEPLOY_PASS", r.stdout)
        self.assertIn("git pull --ff-only", self.log())
        self.assertIn("alembic current --check-heads", self.log())
        self.assertIn("pm2 restart", self.log())
        self.assertNotIn("alembic upgrade", self.log())

    def test_28_runner_local_api(self):
        r = self.run_script("deploy/pm2/run-python.sh", "api")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("--host 127.0.0.1 --port 18090", self.log())

    def test_29_runner_worker(self):
        r = self.run_script("deploy/pm2/run-python.sh", "worker")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("-m app.worker", self.log())

    def test_30_runner_blocks_payout(self):
        self.write_config(WITHDRAWALS_EXECUTION_ENABLED="true")
        r = self.run_script("deploy/pm2/run-python.sh", "api")
        self.assertEqual(r.returncode, 78)
        self.assertNotIn("python -m uvicorn", self.log())

if __name__ == "__main__":
    unittest.main(verbosity=2)
