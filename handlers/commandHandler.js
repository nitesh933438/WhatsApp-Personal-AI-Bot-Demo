let botEnabled = true;
function sameNumber(a, b) {
  const x = String(a || '').replace(/\D/g, '');
  const y = String(b || '').replace(/\D/g, '');
  return !!x && !!y && x === y;
}
async function handleCommand(message, msg, ADMIN_NUMBER) {
  if (!sameNumber(message.from, ADMIN_NUMBER)) return false;
  if (msg === '/bot off') { botEnabled = false; await message.reply('⛔ Bot OFF'); return true; }
  if (msg === '/bot on') { botEnabled = true; await message.reply('✅ Bot ON'); return true; }
  return false;
}
function isBotEnabled() { return botEnabled; }
module.exports = { handleCommand, isBotEnabled };
