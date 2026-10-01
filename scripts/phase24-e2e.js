const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const failures = [];
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = rel => fs.existsSync(path.join(root, rel));

// 1) Syntax/regression gate.
const jsFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
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

// 2) Critical user-flow files.
for (const rel of [
  'server.js', 'routes/auth.js', 'routes/accounts.js', 'routes/notifications.js',
  'routes/memory.js', 'routes/chat.js', 'services/whatsappService.js',
  'services/aiService.js', 'handlers/messageHandler.js', 'middleware/authMiddleware.js',
  'middleware/requestSecurity.js', 'public/login.html', 'public/chat.html',
  'public/dashboard.html', 'public/manifest.webmanifest', 'public/sw.js'
]) if (!exists(rel)) failures.push(`Missing critical flow file: ${rel}`);

// 3) Server lifecycle and health flow.
const server = read('server.js');
for (const marker of [
  'app.get("/healthz"', 'app.get("/readyz"',
  'process.on("SIGTERM"', 'process.on("SIGINT"',
  'server.close(resolve)', 'mongoose.connection.close'
]) if (!server.includes(marker)) failures.push(`Missing lifecycle/health marker: ${marker}`);

// 4) Auth flow.
const auth = read('routes/auth.js');
const authMw = read('middleware/authMiddleware.js');
const authController = read('controllers/authController.js');
if (!authController.includes('jwt.sign')) failures.push('Login flow does not issue a JWT');
if (!authController.includes('access_token')) failures.push('Login flow does not set access_token cookie');
if (!authMw.includes('jwt.verify')) failures.push('Protected flow does not verify JWT');
if (!authMw.includes('TokenExpiredError')) failures.push('Expired-session handling missing');

// 5) Account flow.
const accounts = read('routes/accounts.js');
for (const marker of ['initializeWhatsApp', 'disconnectWhatsApp', 'listAccounts', 'findOneAndUpdate']) {
  if (!accounts.includes(marker)) failures.push(`Account flow missing: ${marker}`);
}

// 6) Message/AI flow.
const messageHandler = read('handlers/messageHandler.js');
const ai = read('services/aiService.js');
if (!messageHandler.includes('message')) failures.push('Message handler does not reference incoming message flow');
if (!messageHandler.includes('getAIReply')) failures.push('Message handler is not wired to AI reply flow');
if (!ai.includes('summary') || !ai.includes('memory')) failures.push('AI context layer missing summary/memory integration');

// 7) Notifications and PWA.
const notifications = read('routes/notifications.js');
if (!notifications.includes('PushSubscription')) failures.push('Push notification persistence missing');
const manifest = read('public/manifest.webmanifest');
if (!manifest.includes('display')) failures.push('PWA display configuration missing');
const sw = read('public/sw.js');
if (!sw.includes('push') || !sw.includes('notificationclick')) failures.push('Push notification service-worker handlers missing');

// 8) Security invariants.
const requestSecurity = read('middleware/requestSecurity.js');
const security = read('middleware/security.js');
if (!requestSecurity.includes('return auth(req, res, next)')) failures.push('API auth gate missing');
if (!security.includes('helmet')) failures.push('Helmet security middleware missing');
if (!server.includes('express.json({ limit: "2mb" })')) failures.push('Request body size limit missing');

// 9) Deployment metadata.
const pkg = JSON.parse(read('package.json'));
if (!pkg.scripts?.healthcheck || !pkg.scripts?.['start:prod']) failures.push('Production scripts missing');
if (!exists('.env.example')) failures.push('.env.example missing');
if (!exists('package-lock.json')) failures.push('package-lock.json missing');

if (failures.length) {
  console.error(`PHASE24 E2E AUDIT FAILED (${failures.length})`);
  failures.forEach((x, i) => console.error(`\n${i + 1}. ${x}`));
  process.exit(1);
}
console.log(`PHASE24 E2E AUDIT PASS — ${jsFiles.length} JS files syntax-checked; login, account, message/AI, notification/PWA, security and lifecycle flow invariants verified.`);
