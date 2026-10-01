"use strict";
const { getAnalytics } = require("../services/analyticsService");
const { normalizeId } = require("../services/whatsappService");

exports.getAnalytics = async (req, res) => {
  try {
    const accountId = normalizeId(req.query.accountId || "default");
    const data = await getAnalytics(accountId);
    res.json({ success: true, accountId, ...data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
