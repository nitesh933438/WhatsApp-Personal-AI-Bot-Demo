const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const failures = [];
const required = [
  'server.js','app.js','.env.example','README.md','package-lock.json',
  'scripts/phase21-test.js','scripts/healthcheck.js','middleware/requestSecurity.js',
  'middleware/authMiddleware.js','config/database.js','services/whatsappService.js',
  'services/aiService.js','handlers/messageHandler.js','public/manifest.webmanifest','public/sw.js'
];
for (const rel of required) if (!fs.existsSync(path.join(root, rel))) failures.push(`Missing required file: ${rel}`);

const jsFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules','.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && full.endsWith('.js')) jsFiles.push(full);
  }
}
walk(root);
for (const file of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) failures.push(`Syntax error: ${path.relative(root,file)}\n${r.stderr.trim()}`);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
for (const script of ['test','healthcheck','start:prod']) {
  if (!pkg.scripts?.[script]) failures.push(`Missing npm script: ${script}`);
}

const server = fs.readFileSync(path.join(root,'server.js'),'utf8');
const checks = [
  ['/healthz', '/healthz'], ['/readyz','/readyz'],
  ['graceful SIGTERM','process.on("SIGTERM"'], ['graceful SIGINT','process.on("SIGINT"'],
  ['shutdown timeout','SHUTDOWN_TIMEOUT_MS'], ['production secret guard','JWT_SECRET and SESSION_SECRET']
];
for (const [label, needle] of checks) if (!server.includes(needle)) failures.push(`Missing ${label} invariant`);

const security = fs.readFileSync(path.join(root,'middleware/requestSecurity.js'),'utf8');
if (!security.includes('crypto.randomUUID')) failures.push('Request ID generation missing');
if (!security.includes("/api/auth/login")) failures.push('Login public-route exception missing');

const env = fs.readFileSync(path.join(root,'.env.example'),'utf8');
for (const key of ['MONGO_URI','GEMINI_API_KEY','JWT_SECRET','SESSION_SECRET','NODE_ENV']) {
  if (!new RegExp(`^${key}=`, 'm').test(env)) failures.push(`.env.example missing ${key}`);
}

const readme = fs.readFileSync(path.join(root,'README.md'),'utf8');
for (const term of ['/healthz','/readyz','npm run start:prod']) {
  if (!readme.includes(term)) failures.push(`README missing deployment reference: ${term}`);
}

const secretFiles = ['.env','.env.local','.env.production'];
for (const f of secretFiles) if (fs.existsSync(path.join(root,f))) failures.push(`Secret file should not be packaged: ${f}`);

if (failures.length) {
  console.error(`PHASE23 AUDIT FAILED (${failures.length})`);
  failures.forEach((x,i)=>console.error(`\n${i+1}. ${x}`));
  process.exit(1);
}
console.log(`PHASE23 AUDIT PASS — ${jsFiles.length} JS files syntax-checked; production, security, health, PWA and packaging invariants verified.`);
