const express = require('express');
const router = express.Router();
const { sendBroadcast } = require('../services/broadcastService');
const { getClient, getStatus, normalizeId } = require('../services/whatsappService');

router.post('/', async (req, res) => {
  try {
    const accountId = normalizeId(req.body?.accountId || 'default');
    const client = getClient(accountId);
    if (!client || getStatus(accountId) !== 'online') return res.status(503).json({ success: false, message: 'WhatsApp is not connected' });
    const text = String(req.body?.message || '').trim();
    if (!text) return res.status(400).json({ success: false, message: 'Message is required' });
    const total = await sendBroadcast(client, text, accountId);
    res.json({ success: true, accountId, message: `✅ Sent to ${total} users` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
module.exports = router;
