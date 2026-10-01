const http = require('http');

const endpoints = [
  '/healthz',
  '/readyz',
  '/api/ai/status',
  '/api/app/version',
  '/api/status'
];

let remaining = endpoints.length;

for (const endpoint of endpoints) {
  const req = http.get('http://localhost:3000' + endpoint, function(res) {
    let data = '';
    res.on('data', function(d) { data += d; });
    res.on('end', function() {
      const icon = res.statusCode < 400 ? '✅' : '❌';
      console.log(icon + ' ' + res.statusCode + ' GET ' + endpoint + '  ' + data.slice(0, 100));
      remaining--;
      if (remaining === 0) process.exit(0);
    });
  });
  req.on('error', function(e) {
    console.log('❌ ERROR ' + endpoint + ': ' + e.message);
    remaining--;
    if (remaining === 0) process.exit(1);
  });
  req.setTimeout(5000, function() {
    console.log('❌ TIMEOUT ' + endpoint);
    req.destroy();
    remaining--;
    if (remaining === 0) process.exit(1);
  });
}
