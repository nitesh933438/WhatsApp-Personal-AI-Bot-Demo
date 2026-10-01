const express = require("express");
const router = express.Router();
const AIMemory = require("../models/AIMemory");
const { getConversationSummary } = require("../services/aiService");
const { normalizeId } = require('../services/whatsappService');


router.get("/:number/summary/cached", async (req, res) => {
  try {
    const User = require("../models/User");
    const accountId = normalizeId(req.query.accountId);
    let user = null;
    try {
      user = await User.findOne({ accountId, number: req.params.number }).lean();
    } catch (_) {}
    res.json({ success: true, summary: user?.conversationSummary || "", updatedAt: user?.summaryUpdatedAt || null });
  } catch (err) { res.json({ success: true, summary: "", updatedAt: null }); }
});

router.get("/:number/summary", async (req, res) => {
  try {
    const accountId = normalizeId(req.query.accountId);
    let summary = "";
    try {
      summary = await getConversationSummary(req.params.number, accountId);
    } catch (_) {}
    res.json({ success: true, summary: summary || "" });
  } catch (err) { res.json({ success: true, summary: "" }); }
});

router.get("/:number", async (req, res) => {
  try {
    const accountId = normalizeId(req.query.accountId);
    let memories = [];
    try {
      memories = await AIMemory.find({ accountId, number: req.params.number, active: true })
        .sort({ updatedAt: -1 }).lean();
    } catch (_) {}
    res.json({ success: true, memories: memories || [] });
  } catch (err) { res.json({ success: true, memories: [] }); }
});

router.post("/:number", async (req, res) => {
  try {
    const accountId = normalizeId(req.query.accountId);
    const key = String(req.body?.key || "").trim().slice(0, 80);
    const value = String(req.body?.value || "").trim().slice(0, 500);
    if (!key || !value) return res.status(400).json({ success: false, message: "key and value are required" });
    const memory = await AIMemory.findOneAndUpdate(
      { accountId, number: req.params.number, key },
      { $set: { value, source: "manual", active: true } },
      { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
    ).lean();
    res.json({ success: true, memory });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete("/:number/:id", async (req, res) => {
  try {
    const accountId = normalizeId(req.query.accountId);
    const memory = await AIMemory.findOneAndUpdate(
      { _id: req.params.id, accountId, number: req.params.number },
      { $set: { active: false } },
      { returnDocument: 'after' }
    );
    if (!memory) return res.status(404).json({ success: false, message: "Memory not found" });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete("/:number", async (req, res) => {
  try {
    const accountId = normalizeId(req.query.accountId);
    await AIMemory.updateMany({ accountId, number: req.params.number }, { $set: { active: false } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
