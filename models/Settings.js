const mongoose = require("mongoose");

const SettingsSchema = new mongoose.Schema({
  accountId: { type: String, default: "default", index: true, unique: true },
  aiEnabled: { type: Boolean, default: true },
  aiPersonality: { type: String, default: "friendly" },
  aiLanguage: { type: String, default: "auto" },
  aiReplyLength: { type: String, default: "balanced" },
  aiInstructions: { type: String, default: "", maxlength: 2000 },
  autoReply: { type: Boolean, default: true },
  replyDelayMin: { type: Number, default: 0, min: 0, max: 120 },
  replyDelayMax: { type: Number, default: 2, min: 0, max: 120 },
  greetingEnabled: { type: Boolean, default: true },
  greetingMessage: { type: String, default: "Hello! How can I help you?" },
  offlineMessage: { type: String, default: "" },
  timezone: { type: String, default: "Asia/Kolkata" },
  businessHoursEnabled: { type: Boolean, default: false },
  businessHoursStart: { type: String, default: "09:00" },
  businessHoursEnd: { type: String, default: "18:00" }
}, { timestamps: true });

module.exports = mongoose.model("Settings", SettingsSchema);
