const { sendBroadcast } = require('../services/broadcastService');
function sameNumber(a, b) {
  const x = String(a || '').replace(/\D/g, '');
  const y = String(b || '').replace(/\D/g, '');
  return !!x && !!y && x === y;
}
async function handleBroadcast(message, client, msg, ADMIN_NUMBER) {
  if (!sameNumber(message.from, ADMIN_NUMBER) || !msg.startsWith('/broadcast ')) return false;
  const text = message.body.slice('/broadcast '.length).trim();
  if (!text) return false;
  const total = await sendBroadcast(client, text, client.accountId);
  await message.reply(`✅ Broadcast Complete\n\nTotal Sent : ${total}`);
  return true;
}
module.exports = { handleBroadcast };
