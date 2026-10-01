const User = require('../models/User');
async function sendBroadcast(client, text, accountId = null) {
  const query = accountId ? { accountId } : {};
  const users = await User.find(query).select('number accountId').lean();
  let total = 0;
  for (const user of users) {
    try { await client.sendMessage(user.number, text); total++; } catch (_) {}
  }
  return total;
}
module.exports = { sendBroadcast };
