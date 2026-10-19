// API and worker ONLY for native Node staging; no Docker control.
if (!process.env.TALA_STAGE_ENV_FILE) throw new Error('STAGING_ENV_PATH_REQUIRED');
module.exports = {
  apps: [
    {
      name: 'tala-node-stage-api',
      cwd: __dirname,
      script: './dist/server.js',
      node_args: ['--env-file=' + process.env.TALA_STAGE_ENV_FILE],
      exec_mode: 'fork', instances: 1, autorestart: true,
      max_memory_restart: '256M', kill_timeout: 10000,
      env: { NODE_ENV: 'staging' }
    },
    {
      name: 'tala-node-stage-worker',
      cwd: __dirname,
      script: './dist/worker.js',
      node_args: ['--env-file=' + process.env.TALA_STAGE_ENV_FILE],
      exec_mode: 'fork', instances: 1, autorestart: true,
      max_memory_restart: '256M', kill_timeout: 10000,
      env: { NODE_ENV: 'staging' }
    }
  ]
};
