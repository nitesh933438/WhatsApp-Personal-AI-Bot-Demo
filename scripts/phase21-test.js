const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const failures = [];
const required = [
  'server.js', 'app.js', 'middleware/authMiddleware.js', 'middleware/requestSecurity.js',
  'middleware/rateLimiter.js', 'middleware/security.js', 'routes/auth.js', 'routes/notes.js',
  'services/whatsappService.js', 'handlers/messageHandler.js'
];

for (const rel of required) if (!fs.existsSync(path.join(root, rel))) failures.push(`Missing required file: ${rel}`);

const jsFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && full.endsWith('.js')) jsFiles.push(full);
  }
}
walk(root);
for (const file of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) failures.push(`Syntax error: ${path.relative(root, file)}\n${r.stderr.trim()}`);
}

const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
if ((server.match(/app\.use\("\/api\/notes"/g) || []).length !== 1) failures.push('Expected exactly one /api/notes mount');
if (server.includes('require("./routes/note")')) failures.push('Broken legacy routes/note.js reference remains');
if (!server.includes('process.env.NODE_ENV === "production"') || !server.includes('JWT_SECRET') || !server.includes('SESSION_SECRET')) failures.push('Production secret guard missing');

const auth = fs.readFileSync(path.join(root, 'middleware/authMiddleware.js'), 'utf8');
if (!auth.includes('jwt.verify')) failures.push('JWT verification missing');
if (!auth.includes('access_token')) failures.push('Cookie token support missing');

const requestSecurity = fs.readFileSync(path.join(root, 'middleware/requestSecurity.js'), 'utf8');
if (!requestSecurity.includes('return auth(req, res, next)')) failures.push('API authentication gate missing');

const authRoute = fs.readFileSync(path.join(root, 'routes/auth.js'), 'utf8');
if (!authRoute.includes('loginLimiter')) failures.push('Login brute-force limiter missing');

const jwt = fs.readFileSync(path.join(root, 'config/jwt.js'), 'utf8');
if (!jwt.includes('"12h"')) failures.push('JWT config expiry is inconsistent with login token expiry');

if (failures.length) {
  console.error(`PHASE21 TEST FAILED (${failures.length})`);
  failures.forEach((x, i) => console.error(`\n${i + 1}. ${x}`));
  process.exit(1);
}
console.log(`PHASE21 TEST PASS — ${jsFiles.length} JS files syntax-checked and production/security invariants verified.`);
