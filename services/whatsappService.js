
'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { Boom } = require('@hapi/boom');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const pino = require('pino');
const appLogger = pino({ level: 'silent' });
const { notify } = require('./pushService');

const clients = new Map();
const sockets = new Map();
const reconnectTimers = new Map();
const reconnectAttempts = new Map();
const runtimeStatuses = new Map();
const runtimeQRs = new Map();
const runtimePairingCodes = new Map();
const pairingRequests = new Set();
const pairingCodeWaiters = new Map();
const pairingCodeRequested = new Set();
const runtimeErrors = new Map();
const runtimeProgress = new Map();
const manualStops = new Set();
const createdAt = new Map();
const rawMessages = new Map();

let runtimeHandlers = {};
let baileys = null;
let runtimeEmergencyStop = false;

const MAX_RECONNECT_DELAY = 60000;
const DEFAULT_RECONNECT_DELAY = 5000;
const MAX_RECONNECT_ATTEMPTS = 5;

function normalizeId(value = 'default') {
  const raw = String(value || 'default').trim();
  return (raw || 'default')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 80) || 'default';
}

function sessionRoot() {
  return path.resolve(
    process.env.WHATSAPP_SESSION_PATH ||
    path.join(process.cwd(), '.baileys_auth')
  );
}

function sessionPath(accountId) {
  return path.join(sessionRoot(), normalizeId(accountId));
}

function setStatus(accountId, status, progress = '') {
  const id = normalizeId(accountId);

  runtimeStatuses.set(id, status);

  if (progress) {
    runtimeProgress.set(id, progress);
  } else {
    runtimeProgress.delete(id);
  }

  const accountUpdate = {
    status,
    runtimeStatus: status,
    ...(progress ? { progress } : {})
  };

  WhatsAppAccount.updateOne(
    { accountId: id },
    { $set: accountUpdate }
  ).catch(() => {});

  if (runtimeHandlers.onStatus) {
    try {
      runtimeHandlers.onStatus(id, accountUpdate);
    } catch (_) {}
  }

  const io = runtimeHandlers.io;
  if (io) {
    io.emit('accountStatus', {
      accountId: id,
      ...accountUpdate
    });
  }
}

function setError(accountId, error) {
  const id = normalizeId(accountId);
  const message = String(
    error?.message || error || 'Unknown WhatsApp error'
  ).slice(0, 1000);

  runtimeErrors.set(id, message);

  WhatsAppAccount.updateOne(
    { accountId: id },
    { $set: { status: 'error', lastError: message } }
  ).catch(() => {});

  setStatus(id, 'error', message);

  accountNotification(
    id,
    'error',
    '⚠️ WhatsApp error',
    message,
    '/dashboard.html'
  );
}

async function accountNotification(
  accountId,
  type,
  title,
  body,
  url = '/dashboard.html'
) {
  try {
    await notify(runtimeHandlers.io, {
      accountId,
      type,
      title,
      body,
      url
    });
  } catch (err) {
    console.warn(
      `[${accountId}] notification failed:`,
      err?.message || err
    );
  }
}

function jidFromNumber(number) {
  const value = String(number || '').trim();

  if (value.includes('@')) return value;

  const digits = value.replace(/\D/g, '');

  if (!digits) {
    throw new Error('Invalid WhatsApp number');
  }

  return `${digits}@s.whatsapp.net`;
}

function numberFromJid(jid) {
  return String(jid || '').split('@')[0];
}

function serializedId(key) {
  if (!key) return '';

  return `${key.fromMe ? 'true' : 'false'}:${key.remoteJid || ''}:${key.id || ''}${key.participant ? `:${key.participant}` : ''}`;
}

class BaileysMessage {
  constructor(raw, sock, accountId) {
    this._raw = raw;
    this._sock = sock;
    this._accountId = accountId;

    const key = raw?.key || {};

    this.id = {
      _serialized: serializedId(key),
      id: key.id || ''
    };

    this.from = key.remoteJid || '';
    this.to = sock?.user?.id || '';
    this.author = key.participant || key.remoteJid || '';
    this.fromMe = !!key.fromMe;
    this.timestamp = Number(
      raw?.messageTimestamp || Date.now() / 1000
    );

    this.type = detectMessageType(raw?.message);
    this.body = extractBody(raw?.message);
    this.hasMedia = !!getMediaNode(raw?.message);

    this._data = {
      notifyName:
        raw?.pushName ||
        raw?.message?.extendedTextMessage?.contextInfo?.participant ||
        ''
    };
  }

  async getContact() {
    const push = String(this._raw?.pushName || '').trim();

    return {
      pushname: push,
      name: push,
      shortName: push,
      verifiedName: push
    };
  }

  async sendSeen() {
    if (
      !this._sock ||
      !this.from ||
      this.from === 'status@broadcast'
    ) return;

    try {
      await this._sock.readMessages([this._raw.key]);
    } catch (_) {}
  }

  async getChat() {
    const sock = this._sock;
    const jid = this.from;

    return {
      id: { _serialized: jid },

      sendStateTyping: async () => {
        try {
          await sock.sendPresenceUpdate('composing', jid);
        } catch (_) {}
      },

      clearState: async () => {
        try {
          await sock.sendPresenceUpdate('paused', jid);
        } catch (_) {}
      }
    };
  }

  async reply(text) {
    const result = await this._sock.sendMessage(
      this.from,
      { text: String(text ?? '') },
      { quoted: this._raw }
    );

    return wrapSentMessage(result, this.from);
  }

  async downloadMedia() {
    const node = getMediaNode(this._raw?.message);

    if (!node || !baileys?.downloadMediaMessage) {
      return null;
    }

    try {
      const buffer = await baileys.downloadMediaMessage(
        this._raw,
        'buffer',
        {},
        { logger: appLogger }
      );

      const mime = node.mimetype || guessMime(this.type);

      return {
        data: buffer.toString('base64'),
        mimetype: mime,
        filename: node.fileName || ''
      };
    } catch (err) {
      console.warn(
        `[${this._accountId}] media download failed:`,
        err?.message || err
      );

      return null;
    }
  }
}

function detectMessageType(message) {
  if (!message) return 'text';
  if (message.imageMessage) return 'image';
  if (message.videoMessage) return 'video';
  if (message.audioMessage) return 'audio';
  if (message.documentMessage) return 'document';
  if (message.stickerMessage) return 'sticker';
  if (message.contactMessage || message.contactsArrayMessage) {
    return 'contact';
  }

  return 'text';
}

function getMediaNode(message) {
  if (!message) return null;

  return (
    message.imageMessage ||
    message.videoMessage ||
    message.audioMessage ||
    message.documentMessage ||
    message.stickerMessage ||
    null
  );
}

function guessMime(type) {
  return type === 'image'
    ? 'image/jpeg'
    : type === 'video'
      ? 'video/mp4'
      : type === 'audio'
        ? 'audio/ogg'
        : 'application/octet-stream';
}

function extractBody(message) {
  if (!message) return '';
  if (message.conversation) return message.conversation;

  if (message.extendedTextMessage?.text) {
    return message.extendedTextMessage.text;
  }

  if (message.imageMessage?.caption) {
    return message.imageMessage.caption;
  }

  if (message.videoMessage?.caption) {
    return message.videoMessage.caption;
  }

  if (message.documentMessage?.caption) {
    return message.documentMessage.caption;
  }

  if (message.buttonsResponseMessage?.selectedDisplayText) {
    return message.buttonsResponseMessage.selectedDisplayText;
  }

  if (message.listResponseMessage?.title) {
    return message.listResponseMessage.title;
  }

  return '';
}

function wrapSentMessage(result, jid) {
  const key = result?.key || {
    id: result?.message?.key?.id || ''
  };

  const id = serializedId(key) || `${jid}:${Date.now()}`;

  return {
    id: {
      _serialized: id,
      id: key.id || id
    },
    to: jid,
    timestamp: Date.now() / 1000
  };
}

function makeClientAdapter(sock, accountId) {
  const emitter = new EventEmitter();

  const client = {
    accountId,
    sock,

    on: (...args) => emitter.on(...args),
    once: (...args) => emitter.once(...args),
    off: (...args) => emitter.off(...args),
    emit: (...args) => emitter.emit(...args),

    async sendMessage(number, content, options = {}) {
      const jid = jidFromNumber(number);
      let payload;

      if (typeof content === 'string') {
        payload = { text: content };
      } else if (
        content?.text ||
        content?.image ||
        content?.video ||
        content?.audio ||
        content?.document
      ) {
        payload = content;
      } else {
        payload = { text: String(content ?? '') };
      }

      const sendOptions = {};

      if (options.quoted) {
        sendOptions.quoted = options.quoted;
      }

      const result = await sock.sendMessage(
        jid,
        payload,
        sendOptions
      );

      const wrapped = wrapSentMessage(result, jid);

      rawMessages.set(wrapped.id._serialized, result);
      trimRawMessages();

      return wrapped;
    },

    async sendText(number, text, options = {}) {
      return this.sendMessage(number, text, options);
    },

    async sendPresenceUpdate(state, number) {
      return sock.sendPresenceUpdate(
        state,
        jidFromNumber(number)
      );
    },

    async getNumberId(number) {
      return { _serialized: jidFromNumber(number) };
    },

    async destroy() {
      try {
        await sock.ws?.close();
      } catch (_) {}
    },

    async logout() {
      return sock.logout();
    }
  };

  return { client, emitter };
}

function trimRawMessages() {
  if (rawMessages.size <= 2000) return;

  const first = rawMessages.keys().next().value;

  if (first) rawMessages.delete(first);
}

async function loadBaileys() {
  if (!baileys) {
    baileys = await import('@whiskeysockets/baileys');
  }

  return baileys;
}

async function initializeWhatsApp(accountId = 'default', options = {}) {
  const id = normalizeId(accountId);

  if (sockets.has(id)) {
    return clients.get(id);
  }

  // If this is an explicit connection/reconnect call, remove any manual stop flag
  if (options.isBackgroundReconnect !== true) {
    manualStops.delete(id);
  } else if (manualStops.has(id)) {
    return null;
  }

  createdAt.set(id, Date.now());
  setStatus(id, 'authenticating', 'Starting WhatsApp connection...');
  runtimeErrors.delete(id);

  fs.mkdirSync(sessionPath(id), { recursive: true });

  try {
    const b = await loadBaileys();

    const { state, saveCreds } = await b.useMultiFileAuthState(
      sessionPath(id)
    );

    // A second connection must not replace an active socket.
    if (sockets.has(id) || manualStops.has(id)) {
      return clients.get(id) || null;
    }

    const sock = b.default({
      auth: b.makeCacheableSignalKeyStore
        ? {
            creds: state.creds,
            keys: b.makeCacheableSignalKeyStore(
              state.keys,
              appLogger
            )
          }
        : state,

      printQRInTerminal: false,
      logger: appLogger,

      browser: b.Browsers?.ubuntu
        ? b.Browsers.ubuntu('Chrome')
        : ['Ubuntu', 'Chrome', '20.0.04'],

      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false
    });

    sockets.set(id, sock);

    const { client, emitter } = makeClientAdapter(sock, id);
    clients.set(id, client);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', update =>
      handleConnectionUpdate(
        id,
        sock,
        client,
        emitter,
        update,
        options
      )
    );

    sock.ev.on('messages.upsert', event =>
      handleMessagesUpsert(id, sock, client, emitter, event)
    );

    sock.ev.on('messages.update', updates =>
      handleMessageUpdates(id, emitter, updates)
    );

    console.log(`📱 [${id}] Baileys socket created`);

    return client;
  } catch (err) {
    if (!sockets.has(id)) {
      setError(id, err);
      scheduleReconnect(id, options);
    }

    throw err;
  }
}



async function requestPairingCode(accountId = 'default', phoneNumber) {
  const id = normalizeId(accountId);
  let phone = String(phoneNumber || '').replace(/\D/g, '');

  if (phone.startsWith('0')) {
    phone = phone.replace(/^0+/, '');
  }
  if (phone.length === 10 && /^[6-9]/.test(phone)) {
    phone = '91' + phone;
  }

  if (phone.length < 8 || phone.length > 15) {
    throw new Error('Enter a valid WhatsApp number with country code (e.g. 919876543210).');
  }

  if (getStatus(id) === 'online') {
    throw new Error('This WhatsApp account is already connected.');
  }

  // Clear previous incomplete session so Baileys can register fresh
  try {
    const sPath = sessionPath(id);
    if (fs.existsSync(sPath)) {
      const credsPath = path.join(sPath, 'creds.json');
      if (fs.existsSync(credsPath)) {
        try {
          const credsData = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
          if (!credsData?.me && !credsData?.registered) {
            fs.rmSync(sPath, { recursive: true, force: true });
          }
        } catch (_) {
          fs.rmSync(sPath, { recursive: true, force: true });
        }
      }
    }
  } catch (_) {}

  await disconnectWhatsApp(id);
  manualStops.delete(id);
  pairingRequests.add(id);
  pairingCodeRequested.delete(id);
  runtimePairingCodes.delete(id);
  runtimeQRs.delete(id);

  let resolveCode;
  let rejectCode;
  let timer;

  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;

    timer = setTimeout(() => {
      pairingCodeWaiters.delete(id);
      reject(new Error('Pairing code timeout. Please check your phone number and try again.'));
    }, 28000);
  });

  pairingCodeWaiters.set(id, {
    resolve: (val) => {
      clearTimeout(timer);
      resolveCode(val);
    },
    reject: (err) => {
      clearTimeout(timer);
      rejectCode(err);
    }
  });

  try {
    await initializeWhatsApp(id, {
      pairingPhoneNumber: phone
    });

    return await codePromise;
  } catch (error) {
    const pending = pairingCodeWaiters.get(id);

    if (pending) {
      pairingCodeWaiters.delete(id);
      pending.reject(error);
    }

    pairingCodeRequested.delete(id);
    pairingRequests.delete(id);
    runtimePairingCodes.delete(id);

    throw error;
  }
}


async function handleConnectionUpdate(
  id,
  sock,
  client,
  emitter,
  update,
  options = {}
) {
  // Ignore events from an old socket after reconnect.
  if (sockets.get(id) !== sock) return;

  const { connection, lastDisconnect, qr } = update || {};

  // QR code handling
  if (qr) {
    if (pairingRequests.has(id)) return;

    runtimePairingCodes.delete(id);
    runtimeQRs.set(id, qr);
    runtimeProgress.set(
      id,
      'Scan the QR code with WhatsApp on your phone.'
    );

    WhatsAppAccount.updateOne(
      { accountId: id },
      { $set: { status: 'qr', qr, lastError: '' } }
    ).catch(() => {});

    setStatus(
      id,
      'qr',
      'Scan the QR code with WhatsApp on your phone.'
    );

    accountNotification(
      id,
      'account',
      '📱 WhatsApp needs pairing',
      'Scan the QR code to link this WhatsApp account.',
      '/dashboard.html'
    );

    const io = runtimeHandlers.io;
    if (io) {
      io.emit('whatsappQR', { accountId: id, qr });
      io.emit('whatsappAccountStatus', {
        accountId: id,
        status: 'qr',
        progress: 'Scan the QR code with WhatsApp on your phone.',
        qr
      });
    }
  }

  // Connecting and pairing code request
  if (connection === 'connecting' && !qr && !runtimeQRs.has(id) && !runtimePairingCodes.has(id)) {
    setStatus(id, 'authenticating', 'Connecting to WhatsApp...');
  }

    const phone = String(options?.pairingPhoneNumber || '')
      .replace(/\D/g, '');

    if (
      phone &&
      pairingRequests.has(id) &&
      !pairingCodeRequested.has(id)
    ) {
      pairingCodeRequested.add(id);

      setTimeout(async () => {
        try {
          if (
            sockets.get(id) !== sock ||
            !pairingRequests.has(id)
          ) {
            return;
          }

          if (typeof sock.requestPairingCode !== 'function') {
            throw new Error(
              'Pairing code is not supported by the installed WhatsApp library.'
            );
          }

          console.log(`[${id}] Requesting pairing code for ${phone}...`);

          const rawCode = await sock.requestPairingCode(phone);

          console.log(`[${id}] Pairing code request succeeded:`, rawCode);

          if (
            sockets.get(id) !== sock ||
            !pairingRequests.has(id)
          ) {
            return;
          }

          let formatted = String(rawCode || '')
            .replace(/[^A-Z0-9]/gi, '')
            .toUpperCase();

          if (formatted.length === 8) {
            formatted = formatted.slice(0, 4) + '-' + formatted.slice(4);
          }

          if (!formatted) {
            throw new Error(
              'WhatsApp did not return a pairing code. Please try again.'
            );
          }

          runtimePairingCodes.set(id, formatted);
          runtimeQRs.delete(id);

          runtimeProgress.set(
            id,
            `Enter code ${formatted} in WhatsApp → Linked devices → Link with phone number.`
          );

          setStatus(
            id,
            'pairing',
            `Pairing code: ${formatted}`
          );

          const io = runtimeHandlers.io;
          if (io) {
            io.emit('whatsappPairingCode', { accountId: id, code: formatted });
          }

          const pending = pairingCodeWaiters.get(id);

          if (pending) {
            pairingCodeWaiters.delete(id);
            pending.resolve({
              accountId: id,
              code: formatted,
              status: 'pairing'
            });
          }
        } catch (error) {
          console.error(
            `[${id}] Pairing code request failed:`,
            error
          );

          const pending = pairingCodeWaiters.get(id);

          if (pending) {
            pairingCodeWaiters.delete(id);
            pending.reject(error);
          }

          pairingCodeRequested.delete(id);
          pairingRequests.delete(id);
          runtimePairingCodes.delete(id);
        }
      }, 2500);
    }

  // Successful connection
  if (connection === 'open') {
    pairingRequests.delete(id);
    reconnectAttempts.delete(id);
    runtimeQRs.delete(id);
    runtimePairingCodes.delete(id);
    runtimeErrors.delete(id);
    runtimeProgress.delete(id);

    const phone = numberFromJid(sock.user?.id || '');

    await WhatsAppAccount.updateOne(
      { accountId: id },
      {
        $set: {
          status: 'online',
          phone,
          qr: '',
          lastError: '',
          lastConnectedAt: new Date()
        }
      }
    ).catch(() => {});

    setStatus(id, 'online');

    console.log(
      `✅ [${id}] WhatsApp connection opened` +
      (phone ? ` as +${phone}` : '')
    );

    accountNotification(
      id,
      'account',
      '🟢 WhatsApp connected',
      phone
        ? `Connected as +${phone}.`
        : 'WhatsApp is now connected.',
      '/dashboard.html'
    );

    try {
      if (runtimeHandlers.onReady) {
        await runtimeHandlers.onReady(client, id);
      }
    } catch (err) {
      console.error(`[${id}] onReady failed:`, err);
    }
  }

  // Connection closed
  if (connection === 'close') {
    const disconnectError = lastDisconnect?.error;

    const code = disconnectError
      ? new Boom(disconnectError).output?.statusCode
      : undefined;

    console.error(`[${id}] WhatsApp disconnect details:`, {
      statusCode: code,
      message: disconnectError?.message,
      data: disconnectError?.data,
      stack: disconnectError?.stack,
      connection
    });

    const pendingPairing = pairingCodeWaiters.get(id);

    if (pendingPairing) {
      pairingCodeWaiters.delete(id);
      pendingPairing.reject(
        new Error(
          `WhatsApp connection closed before pairing code was generated. Status: ${code || 'unknown'}`
        )
      );
    }

    pairingCodeRequested.delete(id);

    const reason =
      code ||
      disconnectError?.message ||
      'connection closed';

    console.warn(
      `⚠️ [${id}] WhatsApp closed: ${reason}`
    );

    if (sockets.get(id) === sock) {
      sockets.delete(id);
      clients.delete(id);
    }

    if (
      manualStops.has(id) ||
      code === baileys?.DisconnectReason?.loggedOut ||
      code === baileys?.DisconnectReason?.badSession
    ) {
      pairingRequests.delete(id);
      runtimeQRs.delete(id);
      runtimePairingCodes.delete(id);

      setStatus(
        id,
        'disconnected',
        code === baileys?.DisconnectReason?.loggedOut
          ? 'Logged out from WhatsApp.'
          : 'Disconnected.'
      );

      accountNotification(
        id,
        code === baileys?.DisconnectReason?.loggedOut
          ? 'account'
          : 'error',
        code === baileys?.DisconnectReason?.loggedOut
          ? '🔴 WhatsApp logged out'
          : '⚠️ WhatsApp disconnected',
        code === baileys?.DisconnectReason?.loggedOut
          ? 'This account was logged out. Pair it again to reconnect.'
          : 'The connection was closed and will not reconnect automatically until you connect it again.',
        '/dashboard.html'
      );

      return;
    }

    setStatus(
      id,
      'authenticating',
      `Reconnecting (${reason})...`
    );

    accountNotification(
      id,
      'account',
      '🔄 Reconnecting WhatsApp',
      `Connection closed (${reason}). The system is trying to reconnect automatically.`,
      '/dashboard.html'
    );

    scheduleReconnect(id, options);
  }
}

function handleMessagesUpsert(id, sock, client, emitter, event) {
  if (!event || event.type !== 'notify') return;

  for (const raw of event.messages || []) {
    if (!raw?.message || raw.key?.fromMe) continue;

    const jid = raw.key?.remoteJid || '';

    if (
      !jid ||
      jid === 'status@broadcast' ||
      jid.endsWith('@g.us') ||
      jid.endsWith('@broadcast')
    ) {
      continue;
    }

    const message = new BaileysMessage(raw, sock, id);

    rawMessages.set(message.id._serialized, raw);
    trimRawMessages();

    emitter.emit('message', message);
  }
}

function handleMessageUpdates(id, emitter, updates) {
  for (const item of updates || []) {
    const key = item?.key;
    if (!key) continue;

    const message = {
      id: { _serialized: serializedId(key) },
      to: key.remoteJid,
      from: key.remoteJid
    };

    let ack = 0;
    const status = item.update?.status;

    if (status === 1) ack = 1;
    else if (status === 2) ack = 2;
    else if (status >= 3) ack = 3;

    if (ack) {
      emitter.emit('message_ack', { ...message, _raw: item }, ack);
    }
  }
}


function scheduleReconnect(id, options = {}) {
  if (manualStops.has(id) || reconnectTimers.has(id)) {
    return;
  }

  const attempts = reconnectAttempts.get(id) || 0;
  const maxAttempts = Math.max(
    1,
    Number(process.env.WHATSAPP_MAX_RECONNECT_ATTEMPTS || 5)
  );

  if (attempts >= maxAttempts) {
    setStatus(
      id,
      'error',
      'Maximum reconnect attempts reached. Please reconnect manually.'
    );

    console.error(
      `[${id}] Maximum reconnect attempts (${maxAttempts}) reached.`
    );
    return;
  }

  const baseDelay = Math.max(
    2500,
    Number(
      options.reconnectDelayMs ||
      process.env.WHATSAPP_RECONNECT_DELAY_MS ||
      DEFAULT_RECONNECT_DELAY
    )
  );

  const delay = Math.min(
    baseDelay * Math.pow(2, Math.min(attempts, 5)),
    MAX_RECONNECT_DELAY
  );

  reconnectAttempts.set(id, attempts + 1);

  console.log(
    `🔁 [${id}] Reconnecting in ${Math.round(delay / 1000)} seconds (attempt ${attempts + 1}/${maxAttempts})`
  );

  const timer = setTimeout(() => {
    reconnectTimers.delete(id);

    if (!manualStops.has(id) && !sockets.has(id)) {
      initializeWhatsApp(id, { ...options, isBackgroundReconnect: true }).catch(err => {
        console.error(
          `[${id}] reconnect failed:`,
          err?.message || err
        );
      });
    }
  }, delay);

  reconnectTimers.set(id, timer);
}

async function disconnectWhatsApp(accountId = 'default') {
  const id = normalizeId(accountId);

  manualStops.add(id);
  reconnectAttempts.delete(id);

  const timer = reconnectTimers.get(id);

  if (timer) clearTimeout(timer);
  reconnectTimers.delete(id);

  const sock = sockets.get(id);

  // Remove first so the old socket's close event is ignored.
  sockets.delete(id);
  clients.delete(id);

  try {
    if (sock) await sock.ws?.close();
  } catch (_) {}

  runtimeQRs.delete(id);
runtimePairingCodes.delete(id);
pairingRequests.delete(id);
pairingCodeRequested.delete(id);

const pendingPairing = pairingCodeWaiters.get(id);

if (pendingPairing) {
  pairingCodeWaiters.delete(id);
  pendingPairing.reject(
    new Error('Pairing request was cancelled.')
  );
}

runtimeErrors.delete(id);

  setStatus(id, 'disconnected', 'Disconnected.');

  return { accountId: id };
}

async function resetWhatsAppPairing(accountId = 'default') {
  const id = normalizeId(accountId);

  manualStops.add(id);
  reconnectAttempts.delete(id);

  const timer = reconnectTimers.get(id);

  if (timer) clearTimeout(timer);
  reconnectTimers.delete(id);

  const sock = sockets.get(id);

  sockets.delete(id);
  clients.delete(id);

  try {
    if (sock) {
      await sock.logout();
    }
  } catch (_) {
    try {
      await sock?.ws?.close();
    } catch (_) {}
  }

  runtimeQRs.delete(id);
runtimePairingCodes.delete(id);
pairingRequests.delete(id);
pairingCodeRequested.delete(id);

const pendingPairing = pairingCodeWaiters.get(id);

if (pendingPairing) {
  pairingCodeWaiters.delete(id);
  pendingPairing.reject(
    new Error('Pairing request was cancelled.')
  );
}

runtimeErrors.delete(id);

  // Only this explicit reset deletes the saved session.
  fs.rmSync(sessionPath(id), {
    recursive: true,
    force: true
  });

  await WhatsAppAccount.updateOne(
    { accountId: id },
    {
      $set: {
        status: 'offline',
        phone: '',
        qr: '',
        lastError: ''
      }
    }
  ).catch(() => {});

  setStatus(
    id,
    'offline',
    'Pairing reset. Ready to connect again.'
  );

  return {
    accountId: id,
    status: 'offline'
  };
}

async function reconnectWhatsApp(accountId = 'default') {
  const id = normalizeId(accountId);

  await disconnectWhatsApp(id);

  manualStops.delete(id);

  const client = await initializeWhatsApp(id);

  return {
    accountId: id,
    status: getStatus(id),
    connected: !!client
  };
}

async function listAccounts() {
  const docs = await WhatsAppAccount.find({})
    .sort({ createdAt: 1 })
    .lean();

  const byId = new Map(
    docs.map(account => [account.accountId, account])
  );

  if (!byId.has('default')) {
    byId.set('default', {
      accountId: 'default',
      name: 'WhatsApp default',
      status: 'offline'
    });
  }

  return [...byId.values()].map(account => ({
    ...account,
    runtimeStatus:
      runtimeStatuses.get(account.accountId) ||
      account.status ||
      'offline',
    qr:
      runtimeQRs.get(account.accountId) ||
      account.qr ||
      '',
    pairingCode:
      runtimePairingCodes.get(account.accountId) || '',
    runtimeError:
      runtimeErrors.get(account.accountId) ||
      account.lastError ||
      '',
    progress:
      runtimeProgress.get(account.accountId) || ''
  }));
}

function getClient(accountId = 'default') {
  return clients.get(normalizeId(accountId)) || null;
}

function getStatus(accountId = 'default') {
  return runtimeStatuses.get(normalizeId(accountId)) || 'offline';
}

function getRuntimeQR(accountId = 'default') {
  return runtimeQRs.get(normalizeId(accountId)) || '';
}

function getRuntimeError(accountId = 'default') {
  return runtimeErrors.get(normalizeId(accountId)) || '';
}

function getRuntimeHealth() {
  return [...runtimeStatuses.entries()].map(
    ([accountId, status]) => ({
      accountId,
      status,
      error: getRuntimeError(accountId),
      ageMs:
        Date.now() -
        (createdAt.get(accountId) || Date.now())
    })
  );
}

function setRuntimeHandlers(handlers = {}) {
  runtimeHandlers = {
    ...runtimeHandlers,
    ...handlers
  };
}

function setEmergencyAutoReplyStop() {
  runtimeEmergencyStop = true;
}

function isEmergencyAutoReplyStopped() {
  return runtimeEmergencyStop;
}

async function startAllAccounts() {
  const docs = await WhatsAppAccount.find({})
    .select('accountId name')
    .lean()
    .catch(() => []);

  const ids = docs.length
    ? docs.map(account => account.accountId)
    : ['default'];

  for (const id of ids) {
    manualStops.delete(normalizeId(id));

    initializeWhatsApp(id, {
      name: docs.find(account => account.accountId === id)?.name
    }).catch(err => {
      console.error(
        `[${id}] auto-start failed:`,
        err?.message || err
      );
    });
  }
}

async function stopAllAccounts() {
  for (const id of [...sockets.keys()]) {
    await disconnectWhatsApp(id);
  }
}

module.exports = {
  initializeWhatsApp,
  requestPairingCode,
  getClient,
  getStatus,
  getRuntimeQR,
  getRuntimeError,
  listAccounts,
  disconnectWhatsApp,
  normalizeId,
  setRuntimeHandlers,
  startAllAccounts,
  stopAllAccounts,
  reconnectWhatsApp,
  resetWhatsAppPairing,
  getRuntimeHealth,
  setEmergencyAutoReplyStop,
  isEmergencyAutoReplyStopped
};
