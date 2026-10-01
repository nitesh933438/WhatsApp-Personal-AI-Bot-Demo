const mongoose = require("mongoose");

const AIMemorySchema = new mongoose.Schema({
  accountId: { type: String, default: "default", index: true },
  number: { type: String, required: true, index: true },
  key: { type: String, required: true, trim: true, maxlength: 80 },
  value: { type: String, required: true, trim: true, maxlength: 500 },
  source: { type: String, enum: ["user", "manual", "ai"], default: "user" },
  active: { type: Boolean, default: true }
}, { timestamps: true });

AIMemorySchema.index({ accountId: 1, number: 1, active: 1, updatedAt: -1 });
AIMemorySchema.index({ accountId: 1, number: 1, key: 1 }, { unique: true });

module.exports = mongoose.model("AIMemory", AIMemorySchema);
