"use strict";
const { generateReport } = require("../services/reportService");
const { normalizeId } = require("../services/whatsappService");

exports.getReport = async (req, res) => {
  try {
    const accountId = normalizeId(req.query.accountId || "default");
    const options = {
      startDate: req.query.startDate || null,
      endDate: req.query.endDate || null,
      type: req.query.type || "summary"
    };
    const report = await generateReport(accountId, options);
    res.json({ success: true, report });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
