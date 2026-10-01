'use strict';
require('dotenv').config();

const required = ['JWT_SECRET', 'SESSION_SECRET'];
const failures = [];
const warnings = [];

for (const key of required) {
  if (!process.env[key] || process.env[key].trim().length < 32 || /replace-with|change-this/i.test(process.env[key])) {
    failures.push(`${key} must be a real random secret of at least 32 characters`);
  }
}

if (!(process.env.MONGO_URI || process.env.MONGODB_URI)) failures.push('MONGO_URI (or MONGODB_URI) is required');
if (!process.env.GEMINI_API_KEY) warnings.push('GEMINI_API_KEY is not set; AI replies will not work');
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) warnings.push('VAPID keys are not set; browser push notifications will be unavailable');
if (!process.env.VAPID_SUBJECT) warnings.push('VAPID_SUBJECT is not set; using web-push default is not recommended');
if (!process.env.CORS_ORIGIN) warnings.push('CORS_ORIGIN is empty; set it to the production dashboard origin when the frontend is hosted separately');
if (!process.env.WHATSAPP_SESSION_PATH) warnings.push('WHATSAPP_SESSION_PATH is not set; Baileys will use .baileys_auth relative to the app directory');

const result = { ok: failures.length === 0, node: process.version, env: process.env.NODE_ENV || 'development', failures, warnings };
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exit(1);
