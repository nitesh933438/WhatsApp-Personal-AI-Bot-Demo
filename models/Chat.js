const mongoose = require("mongoose");

const ChatSchema = new mongoose.Schema({
  accountId: { type: String, default: "default", index: true },
  number: { type: String, required: true, index: true },
  sender: { type: String, enum: ["user", "bot", "admin"], required: true },
  message: { type: String, default: "" },
  messageType: { type: String, enum: ["text", "image", "video", "audio", "document", "sticker", "media"], default: "text" },
  mediaUrl: { type: String, default: "" },
  fileName: { type: String, default: "" },
  mimeType: { type: String, default: "" },
  status: { type: String, enum: ["sent", "delivered", "read", "failed"], default: "sent" },
  messageId: { type: String, default: "" },
  replyTo: { type: String, default: "" },
  deleted: { type: Boolean, default: false },
  reaction: { type: String, default: "" }
}, { timestamps: true });

ChatSchema.index({ accountId: 1, number: 1, createdAt: 1 });
module.exports = mongoose.model("Chat", ChatSchema);
