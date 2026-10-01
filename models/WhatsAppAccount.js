const mongoose = require('mongoose');
const WhatsAppAccountSchema = new mongoose.Schema({
  accountId: { type: String, required: true, unique: true, index: true, trim: true },
  name: { type: String, default: 'WhatsApp Account', trim: true, maxlength: 80 },
  phone: { type: String, default: '' },
  status: { type: String, enum: ['offline','qr','authenticating','online','disconnected','error'], default: 'offline' },
  autoReply: { type: Boolean, default: true },
  awayEnabled: { type: Boolean, default: false },
  awayMessage: { type: String, default: 'I am away right now. I will get back to you soon.', maxlength: 500 },
  awayStart: { type: String, default: '22:00' },
  awayEnd: { type: String, default: '08:00' },
  defaultReplyDelayMin: { type: Number, default: 0, min: 0, max: 120 },
  defaultReplyDelayMax: { type: Number, default: 2, min: 0, max: 120 },
  createdAt: { type: Date, default: Date.now },
  lastConnectedAt: { type: Date, default: null },
  lastError: { type: String, default: '' },
  qr: { type: String, default: '' },
  notificationsEnabled: { type: Boolean, default: true },
  pushEnabled: { type: Boolean, default: true }
}, { timestamps: true });
module.exports = mongoose.model('WhatsAppAccount', WhatsAppAccountSchema);
