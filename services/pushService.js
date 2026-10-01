const PushSubscription = require("../models/PushSubscription");
const Notification = require("../models/Notification");
const WhatsAppAccount = require("../models/WhatsAppAccount");

let webpush = null;
try { webpush = require("web-push"); } catch (_) {}

function configured() {
  return !!(webpush && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
}
if (configured()) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

async function createNotification(data = {}) {
  const doc = await Notification.create({
    accountId: String(data.accountId || "default"), number: String(data.number || ""),
    type: data.type || "system", title: String(data.title || "Personal Bot").slice(0,160),
    body: String(data.body || "").slice(0,1000), url: data.url || "/chat"
  });
  return doc.toObject();
}

async function sendPush(payload, filter = {}) {
  if (!configured()) return { sent: 0, skipped: true, reason: "VAPID_NOT_CONFIGURED" };
  const query = {};
  if (filter.accountId) query.accountId = String(filter.accountId);
  let subs = await PushSubscription.find(query).lean();
  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { TTL: 300 });
      sent++;
      await PushSubscription.updateOne({ _id: sub._id }, { $set: { lastUsedAt: new Date() } });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) await PushSubscription.deleteOne({ _id: sub._id });
    }
  }
  return { sent, skipped: false };
}

async function notify(io, data = {}) {
  const accountId = String(data.accountId || "default");
  let account = null;
  try { account = await WhatsAppAccount.findOne({ accountId }).select("notificationsEnabled pushEnabled").lean(); } catch (_) {}
  if (account?.notificationsEnabled === false) return null;
  const notification = await createNotification(data);
  if (io) io.emit("notification", notification);
  if (account?.pushEnabled !== false) await sendPush(notification, { accountId: notification.accountId });
  return notification;
}

module.exports = { configured, createNotification, sendPush, notify };
