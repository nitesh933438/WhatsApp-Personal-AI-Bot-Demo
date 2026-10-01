const path = require("path");
const fs = require("fs");
const { saveUser, saveChatHistory, updateMessageCount, updateAIReplyCount } = require("../services/userService");
const { handleCommand, isBotEnabled } = require("./commandHandler");
const { handleBroadcast } = require("./broadcastHandler");
const { handleAI } = require("./aiHandler");
const User = require("../models/User");
const WhatsAppAccount = require("../models/WhatsAppAccount");
const { extractMemories, saveAutoMemories, getConversationSummary } = require("../services/aiService");
const { notify } = require("../services/pushService");
const { isEmergencyAutoReplyStopped } = require('../services/whatsappService');
const { buildGreeting, shouldGreet } = require("../utils/greeting");
const { detectLanguage, detectIntent } = require("../services/aiService");
const mongoose = require("mongoose");

// Runtime safety: ignore duplicate webhook/event deliveries and serialize AI replies per contact.
// IMPORTANT: one contact must never block another contact. Database persistence is
// best-effort and is deliberately kept out of the critical WhatsApp reply path.
function isDbReady() { return mongoose.connection.readyState === 1; }

async function safeDb(label, task, fallback = null, timeoutMs = 2500) {
  if (!isDbReady()) return fallback;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise(resolve => setTimeout(() => resolve(fallback), timeoutMs))
    ]);
  } catch (err) {
    console.warn(`⚠️ DB ${label} skipped:`, err?.message || err);
    return fallback;
  }
}

// Chat history is user-visible data and must not be silently dropped just
// because MongoDB was briefly reconnecting or one operation took longer than
// the normal UI timeout. We retry critical chat writes independently so the
// WhatsApp reply path stays responsive while the history is eventually
// persisted.
async function persistChatEventually(label, task, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 6));
  const baseDelay = Math.max(250, Number(options.baseDelay || 750));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (!isDbReady()) {
        await new Promise(resolve => setTimeout(resolve, Math.min(3000, baseDelay * attempt)));
        continue;
      }
      return await task();
    } catch (err) {
      if (attempt === attempts) {
        console.error(`❌ DB ${label} could not be persisted after ${attempts} attempts:`, err?.message || err);
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(5000, baseDelay * attempt)));
    }
  }
  return null;
}
const processedMessages = new Map();
const activeJobs = new Map();
const MAX_ACTIVE_PER_CONTACT = 1;
function messageKey(accountId, message) { return `${accountId}:${message?.id?._serialized || message?.id?.id || `${message?.from}:${message?.timestamp}:${message?.body}`}`; }
function wasProcessed(key) {
  const now = Date.now();
  for (const [k,t] of processedMessages) if (now - t > 10 * 60 * 1000) processedMessages.delete(k);
  if (processedMessages.has(key)) return true;
  processedMessages.set(key, now);
  return false;
}
async function runSerialized(key, job) {
  const previous = activeJobs.get(key) || Promise.resolve();
  const next = previous.catch(()=>{}).then(job);
  activeJobs.set(key, next);
  try { return await next; } finally { if (activeJobs.get(key) === next) activeJobs.delete(key); }
}

async function downloadMedia(message) {
  if (!message.hasMedia) return {};
  try {
    const media = await message.downloadMedia();
    if (!media?.data) return {};
    const dir = path.join(__dirname, "../uploads/chat");
    fs.mkdirSync(dir, { recursive: true });
    const ext = (media.mimetype?.split("/")[1] || "bin").split(";")[0].replace(/[^a-z0-9]/gi, "");
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext || "bin"}`;
    fs.writeFileSync(path.join(dir, filename), media.data, "base64");
    const type = media.mimetype?.startsWith("image/") ? "image" : media.mimetype?.startsWith("video/") ? "video" : media.mimetype?.startsWith("audio/") ? "audio" : message.type === "sticker" ? "sticker" : "document";
    return { mediaUrl: `/uploads/chat/${filename}`, fileName: message._data?.filename || filename, mimeType: media.mimetype || "", messageType: type };
  } catch (err) { console.error("Media download error:", err.message); return {}; }
}

function isWithinAwayWindow(start, end, now = new Date()) {
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(':').map(Number), [eh, em] = end.split(':').map(Number);
  const s = sh * 60 + sm, e = eh * 60 + em;
  return s === e ? true : s < e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
}

function randomDelay(min, max) {
  const a = Math.max(0, Number(min) || 0), b = Math.max(a, Number(max) || a);
  return Math.round((a + Math.random() * (b - a)) * 1000);
}

function samePhone(a, b) { const x=String(a||'').replace(/\D/g,''); const y=String(b||'').replace(/\D/g,''); return !!x && !!y && x===y; }

function registerMessageHandler(client, getAIReply, ADMIN_NUMBER, io, accountId="default") {
  client.on("message_ack", async (message, ack) => {
    try {
      const messageId = message?.id?._serialized;
      if (!messageId) return;
      const status = ack >= 3 ? "read" : ack >= 2 ? "delivered" : ack >= 1 ? "sent" : "failed";
      const Chat = require("../models/Chat");
      await Chat.updateOne({ accountId, messageId }, { $set: { status } });
      if (io) io.emit("messageAck", { accountId, number: message?.to, messageId, status });
    } catch (_) {}
  });

  client.on("message", async (message) => {
    const dedupeKey = messageKey(accountId, message);
    if (wasProcessed(dedupeKey)) return;
    const contactKey = `${accountId}:${message?.from || "unknown"}`;
    try {
      await runSerialized(contactKey, async () => {
      if (!message.from || message.from === "status@broadcast" || message.from.includes("@g.us")) return;
      try { await message.sendSeen(); } catch (_) {}
      const contact = await message.getContact();
      // WhatsApp can expose the display name through different fields depending
      // on device/account state. Resolve the best available name before greeting.
      const existingProfile = await safeDb("profile lookup", () => User.findOne({ accountId, number: message.from }).lean(), null);
      const validDisplayName = (value) => {
        const v = String(value || "").trim().replace(/\s+/g, " ");
        if (!v || /^(user|unknown|there|contact|whatsapp user|you)$/i.test(v)) return "";
        if (/^\+?\d[\d\s().-]{5,}$/.test(v)) return "";
        return v.slice(0, 80);
      };
      // whatsapp-web.js exposes the contact name differently across devices.
      // Prefer the real WhatsApp display/push name and only then use our saved profile.
      const rawContactName = [
        contact?.pushname,
        contact?.name,
        contact?.shortName,
        contact?.verifiedName,
        message?._data?.notifyName,
        message?._data?.sender?.pushname,
        message?._data?.sender?.name,
        message?._data?.sender?.notifyName
      ].map(validDisplayName).find(Boolean) || "";
      const savedName = validDisplayName(existingProfile?.name);
      const name = rawContactName || savedName || "";
      const raw = (message.body || "").trim();
      const media = await downloadMedia(message);
      if (!raw && !media.mediaUrl) return;
      const displayMessage = raw || `[${media.messageType || "media"}]`;
      const messageId = message.id?._serialized || "";

      const existingUser = existingProfile || await safeDb("user lookup", () => User.findOne({ accountId, number: message.from }).lean(), null);
      const greetingDue = shouldGreet(existingUser, Date.now(), raw);

      // Never overwrite a known contact name with a placeholder when WhatsApp
      // temporarily does not expose the display name.
      await safeDb("save user", () => saveUser(message.from, name || savedName || "User", displayMessage, accountId));
      await safeDb("message count", () => updateMessageCount(message.from, accountId));
      if (isDbReady()) {
        User.findOne({ accountId, number: message.from }).lean().then(async u => {
          if ((u?.totalMessages || 0) > 0 && (u.totalMessages % 12 === 0)) {
            try { await getConversationSummary(message.from, accountId); } catch (_) {}
          }
        }).catch(() => {});
      }
      await persistChatEventually("incoming message", () => saveChatHistory(message.from, "user", displayMessage, { ...media, messageId, status: "delivered", accountId }), { attempts: 12, baseDelay: 500 });

      // Refresh the long-term conversation summary in the background every ~12 messages.
      if (io) io.emit("newMessage", { accountId, number: message.from, name, message: displayMessage, sender: "user", time: new Date().toISOString(), messageType: media.messageType || "text", mediaUrl: media.mediaUrl || "", fileName: media.fileName || "", mimeType: media.mimeType || "", messageId, status: "delivered" });
      await notify(io, { accountId, number: message.from, type: "message", title: `💬 New message${name ? ` from ${name}` : ""}`, body: displayMessage, url: `/chat?accountId=${encodeURIComponent(accountId)}&number=${encodeURIComponent(message.from)}` });

      const msg = raw.toLowerCase();
      if (!raw) return;
      if (await handleCommand(message, msg, ADMIN_NUMBER)) return;
      if (!isBotEnabled()) return;
      if (isEmergencyAutoReplyStopped()) return;
      const userSettings = await safeDb("user settings", () => User.findOne({ accountId, number: message.from }).lean(), null);
      if (userSettings?.aiEnabled === false) return;
      const accountSettings = await safeDb("account settings", () => WhatsAppAccount.findOne({ accountId }).lean(), null);
      if (accountSettings?.autoReply === false || userSettings?.autoReply === false || userSettings?.humanTakeover === true || userSettings?.excludedFromAI === true) return;
      if (await handleBroadcast(message, client, msg, ADMIN_NUMBER)) return;

      if (accountSettings?.awayEnabled && isWithinAwayWindow(accountSettings.awayStart, accountSettings.awayEnd)) {
        const awayText = String(accountSettings.awayMessage || '').trim();
        if (awayText) {
          const sentAway = await message.reply(awayText);
          const awayId = sentAway?.id?._serialized || '';
          await persistChatEventually("away message", () => saveChatHistory(message.from, "bot", awayText, { messageId: awayId, status: "sent", replyTo: messageId, accountId, messageType: "text" }), { attempts: 12, baseDelay: 500 });
          if (io) io.emit("botReply", { accountId, number: message.from, name, message: awayText, sender: "bot", time: new Date().toISOString(), messageId: awayId, status: "sent", replyTo: messageId, kind: "away" });
          await notify(io, { accountId, number: message.from, type: "ai_reply", title: `🤖 AI replied${name ? ` to ${name}` : ""}`, body: awayText, url: `/chat?accountId=${encodeURIComponent(accountId)}&number=${encodeURIComponent(message.from)}` });
        }
        return;
      }
      if (isDbReady() && userSettings?.aiMemory !== false) {
        extractMemories(message.from, raw, accountId).then(facts => saveAutoMemories(message.from, facts, accountId)).catch(() => {});
      }

      // Generate the reply first. Then simulate a natural composing period based
      // on the configured delay and reply length, instead of making the user wait
      // silently before the assistant even starts typing.
      const aiReply = await handleAI(message, (question, number) => getAIReply(question, number || message.from, accountId));
      if (!aiReply) return;

      const isNitesh = samePhone(message.from, ADMIN_NUMBER);
      // Only the owner gets the honorific. Other contacts are greeted by a real
      // display name when it is usable; emoji-only names are omitted.
      const safeName = /[A-Za-z\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0B00-\u0B7F\u0C00-\u0C7F\u0D00-\u0D7F]/u.test(String(name || "")) ? String(name).trim() : "";
      const greetingName = isNitesh ? "Nitesh" : safeName;
      const currentIntent = detectIntent(raw);
      const language = detectLanguage(raw);
      // Explicit greetings should always be personalized (when a real name is
      // available) and use the local time. Replace the generic AI greeting so
      // the contact never receives two greetings in the same reply.
      const isExplicitGreeting = currentIntent === "greeting";
      const canPrependTimeGreeting = greetingDue && !["greeting", "identity", "location", "activity", "question", "help", "thanks", "apology", "affection"].includes(currentIntent);
      const greeting = isExplicitGreeting || canPrependTimeGreeting
        ? buildGreeting(greetingName, language, undefined, isNitesh ? { honorific: "sir" } : {})
        : "";
      const greetingFollowup = ({
        english: "How are you?",
        hindi: "आप कैसे हैं?",
        hinglish: "Kaise ho?",
        bhojpuri: "कइसन बानी?"
      })[language] || "How are you?";
      const reply = isExplicitGreeting
        ? `${greeting} ${greetingFollowup}`
        : greeting ? `${greeting}\n\n${aiReply}` : aiReply;
      const configuredMin = userSettings?.replyDelayMin ?? accountSettings?.defaultReplyDelayMin ?? 0;
      const configuredMax = userSettings?.replyDelayMax ?? accountSettings?.defaultReplyDelayMax ?? 2;
      // Keep a short, human-feeling delay. Long configured delays are still respected,
      // but normal chat gets an additional small response-length component.
      const lengthSeconds = Math.min(1.8, Math.max(0.25, reply.length / 180));
      const delayMin = Math.max(0, Number(configuredMin) || 0);
      const delayMax = Math.max(delayMin, Number(configuredMax) || Math.min(delayMin + 2, 2));
      const delayMs = Math.min(12000, randomDelay(delayMin, delayMax) + Math.round(lengthSeconds * 1000));
      if (io) io.emit("typing", { accountId, number: message.from, typing: true });
      let chat = null;
      try {
        chat = await message.getChat();
        if (chat?.sendStateTyping) await chat.sendStateTyping();
      } catch (_) {}
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));

      let sent;
      try {
        sent = await message.reply(reply);
      } finally {
        try {
          if (chat?.clearState) await chat.clearState();
        } catch (_) {}
        if (io) io.emit("typing", { accountId, number: message.from, typing: false });
      }
      const botId = sent?.id?._serialized || "";
      await persistChatEventually("bot message", () => saveChatHistory(message.from, "bot", reply, { messageId: botId, status: "sent", replyTo: messageId, accountId }), { attempts: 12, baseDelay: 500 });
      if (greeting && isDbReady()) {
        await safeDb("greeting timestamp", () => User.updateOne({ accountId, number: message.from }, { $set: { lastGreetingAt: new Date() } }));
      }
      await safeDb("AI reply count", () => updateAIReplyCount(message.from, accountId));
      if (io) io.emit("botReply", { accountId, number: message.from, name, message: reply, sender: "bot", time: new Date().toISOString(), messageId: botId, status: "sent", replyTo: messageId });
      await notify(io, { accountId, number: message.from, type: "ai_reply", title: `🤖 AI replied${name ? ` to ${name}` : ""}`, body: reply, url: `/chat?accountId=${encodeURIComponent(accountId)}&number=${encodeURIComponent(message.from)}` });
      });
    } catch (err) { console.error("Message Handler Error:", err); }
  });
}
module.exports = { registerMessageHandler };
