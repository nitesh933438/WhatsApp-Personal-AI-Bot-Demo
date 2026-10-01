const mongoose = require("mongoose");

const ReportSchema = new mongoose.Schema({
  accountId: { type: String, default: "default", index: true },
  type: { type: String, default: "general" },
  title: { type: String, default: "" },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  generatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model("Report", ReportSchema);
