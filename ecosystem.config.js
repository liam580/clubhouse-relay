module.exports = {
  apps: [
    {
      name: 'clubhouse-relay',
      script: './src/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      max_memory_restart: '256M',
      out_file: './data/pm2-out.log',
      error_file: './data/pm2-err.log',
      merge_logs: true,
      time: true,
      env: { NODE_ENV: 'production' }
    }
  ]
};
