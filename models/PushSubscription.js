const mongoose = require("mongoose");
const PushSubscriptionSchema = new mongoose.Schema({
  endpoint: { type: String, required: true, unique: true, index: true },
  keys: { p256dh: { type: String, required: true }, auth: { type: String, required: true } },
  accountId: { type: String, default: "default", index: true },
  deviceLabel: { type: String, default: "", maxlength: 100 },
  createdAt: { type: Date, default: Date.now },
  lastUsedAt: { type: Date, default: Date.now }
}, { timestamps: true });
module.exports = mongoose.model("PushSubscription", PushSubscriptionSchema);
