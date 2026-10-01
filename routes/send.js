const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();
const { getClient, getStatus, normalizeId } = require('../services/whatsappService');
const { saveChatHistory, saveUser } = require('../services/userService');

const uploadDir = path.join(__dirname, '../uploads/chat');
fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${path.extname(file.originalname || '')}`)
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

router.post('/', upload.single('file'), async (req, res) => {
  try {
    const number = String(req.body?.number || '').trim();
    const accountId = normalizeId(req.body?.accountId || 'default');
    const message = String(req.body?.message || '').trim();
    const replyTo = String(req.body?.replyTo || '').trim();
    if (!number || (!message && !req.file)) return res.status(400).json({ success: false, message: 'number and message or file are required' });
    const client = getClient(accountId);
    if (!client || getStatus(accountId) !== 'online') return res.status(503).json({ success: false, message: 'WhatsApp is not connected' });

    let result;
    let messageType = 'text';
    let mediaUrl = '';
    let fileName = '';
    let mimeType = '';
    if (req.file) {
      const buffer = fs.readFileSync(req.file.path);
      mimeType = req.file.mimetype || 'application/octet-stream';
      fileName = req.file.originalname || path.basename(req.file.path);
      messageType = mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : 'document';
      const payload = { [messageType]: buffer, mimetype: mimeType, fileName };
      if (message) payload.caption = message;
      result = await client.sendMessage(number, payload, {});
      mediaUrl = `/uploads/chat/${path.basename(req.file.path)}`;
    } else {
      result = await client.sendMessage(number, message, {});
    }
    const id = result?.id?._serialized || '';
    await saveUser(number, 'User', message || fileName || `[${messageType}]`, accountId);
    await saveChatHistory(number, 'admin', message || fileName || `[${messageType}]`, { messageType, mediaUrl, fileName, mimeType, messageId: id, replyTo, status: 'sent', accountId });
    const io = req.app.get('io');
    if (io) io.emit('messageSent', { accountId, number, message: message || fileName || `[${messageType}]`, messageType, mediaUrl, fileName, mimeType, id, replyTo, time: new Date().toISOString(), status: 'sent' });
    res.json({ success: true, accountId, id, status: 'sent', messageType, mediaUrl, fileName, mimeType, replyTo });
  } catch (err) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
    res.status(500).json({ success: false, message: err.message });
  }
});
module.exports = router;
