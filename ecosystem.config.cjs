module.exports = {
  apps: [
    {
      name: 'isthatgoodformyteam',
      script: './server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 8000
      }
    }
  ]
};
