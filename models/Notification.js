const mongoose = require("mongoose");
const NotificationSchema = new mongoose.Schema({
  accountId: { type: String, default: "default", index: true },
  number: { type: String, default: "", index: true },
  type: { type: String, default: "system", enum: ["message","ai_reply","account","error","system"] },
  title: { type: String, required: true, maxlength: 160 },
  body: { type: String, default: "", maxlength: 1000 },
  url: { type: String, default: "/chat" },
  read: { type: Boolean, default: false, index: true },
  createdAt: { type: Date, default: Date.now, index: true }
}, { timestamps: true });
module.exports = mongoose.model("Notification", NotificationSchema);
