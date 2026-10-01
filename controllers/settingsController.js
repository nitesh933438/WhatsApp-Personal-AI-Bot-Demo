"use strict";
const Settings = require("../models/Settings");
const { normalizeId } = require("../services/whatsappService");

const inMemorySettings = new Map();

function defaultSettings(accountId = "default") {
  return {
    accountId,
    aiEnabled: true,
    aiPersonality: "friendly",
    aiLanguage: "auto",
    aiReplyLength: "balanced",
    aiInstructions: "",
    autoReply: true,
    replyDelayMin: 0,
    replyDelayMax: 2,
    greetingEnabled: true,
    greetingMessage: "Hello! How can I help you?",
    offlineMessage: "",
    timezone: "Asia/Kolkata",
    businessHoursEnabled: false,
    businessHoursStart: "09:00",
    businessHoursEnd: "18:00"
  };
}

exports.getSettings = async (req, res) => {
  const accountId = normalizeId(req.query.accountId || "default");
  try {
    let settings = null;
    try {
      settings = await Settings.findOne({ accountId }).lean();
      if (!settings) {
        settings = await Settings.create(defaultSettings(accountId));
      }
    } catch (_) {}
    if (!settings) {
      settings = inMemorySettings.get(accountId) || defaultSettings(accountId);
    }
    res.json({ success: true, settings });
  } catch (err) {
    const fallback = inMemorySettings.get(accountId) || defaultSettings(accountId);
    res.json({ success: true, settings: fallback });
  }
};

exports.updateSettings = async (req, res) => {
  const accountId = normalizeId(req.body?.accountId || req.query.accountId || "default");
  try {
    const allowed = [
      "aiEnabled", "aiPersonality", "aiLanguage", "aiReplyLength",
      "aiInstructions", "autoReply", "replyDelayMin", "replyDelayMax",
      "greetingEnabled", "greetingMessage", "offlineMessage",
      "timezone", "businessHoursEnabled", "businessHoursStart", "businessHoursEnd"
    ];
    const update = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }
    let settings = null;
    try {
      settings = await Settings.findOneAndUpdate(
        { accountId },
        { $set: update },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();
    } catch (_) {}
    if (!settings) {
      const current = inMemorySettings.get(accountId) || defaultSettings(accountId);
      settings = { ...current, ...update, accountId, updatedAt: new Date().toISOString() };
      inMemorySettings.set(accountId, settings);
    }
    res.json({ success: true, settings });
  } catch (err) {
    const fallback = inMemorySettings.get(accountId) || defaultSettings(accountId);
    res.json({ success: true, settings: fallback });
  }
};
