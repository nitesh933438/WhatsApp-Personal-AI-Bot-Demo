'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');

process.env.NODE_ENV = process.env.NODE_ENV || 'production';

process.env.WHATSAPP_SESSION_PATH =
process.env.WHATSAPP_SESSION_PATH ||
path.join(process.cwd(), '.baileys_auth');

const sessionPath = path.resolve(process.env.WHATSAPP_SESSION_PATH);
process.env.WHATSAPP_SESSION_PATH = sessionPath;

fs.mkdirSync(sessionPath, { recursive: true });
console.log(`💾 WhatsApp sessions: ${sessionPath}`);

require('../server');