const http = require('http');
const port = Number(process.env.PORT || 3000);
const host = process.env.HEALTHCHECK_HOST || '127.0.0.1';
const path = process.env.HEALTHCHECK_PATH || '/readyz';
const attempts = Math.max(1, Number(process.env.HEALTHCHECK_ATTEMPTS || 10));
const interval = Math.max(50, Number(process.env.HEALTHCHECK_INTERVAL_MS || 500));

function check() {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path, timeout: 5000 }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode, body });
        else reject(new Error(`HTTP ${res.statusCode}: ${body}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Healthcheck timeout')));
    req.on('error', reject);
  });
}

(async () => {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const result = await check();
      process.stdout.write(result.body + '\n');
      process.exit(0);
    } catch (err) {
      last = err;
      if (i < attempts) await new Promise(r => setTimeout(r, interval));
    }
  }
  console.error(`Healthcheck failed after ${attempts} attempts: ${last?.message || 'unknown error'}`);
  process.exit(1);
})();
