// PM2-only process management for isolated TALA EATS staging (no Docker).
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const runner = path.join(__dirname, "run-python.sh");
const cwd = path.join(root, "backend");
module.exports = {
  apps: [
    {
      name: "talaeats-pm2-api-stage",
      cwd,
      script: runner,
      interpreter: "/bin/bash",
      args: ["api"],
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      min_uptime: "5s",
      max_restarts: 5,
      kill_timeout: 30000,
      watch: false
    },
    {
      name: "talaeats-pm2-worker-stage",
      cwd,
      script: runner,
      interpreter: "/bin/bash",
      args: ["worker"],
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      min_uptime: "5s",
      max_restarts: 5,
      kill_timeout: 30000,
      watch: false
    }
  ]
};
