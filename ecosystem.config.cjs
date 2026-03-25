module.exports = {
  apps: [{
    name: 'phone-connect',
    script: 'server.js',
    cwd: __dirname,
    // Auto-restart on crash
    autorestart: true,
    max_restarts: 10,
    restart_delay: 2000,
    // Watch for file changes (optional - disable if you don't want auto-reload)
    watch: false,
    // Logs
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    // Environment
    env: {
      NODE_ENV: 'production'
    }
  }]
};
