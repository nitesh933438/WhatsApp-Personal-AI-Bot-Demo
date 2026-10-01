const express = require("express");
const router = express.Router();
const Chat = require("../models/Chat");
const User = require("../models/User");
const { normalizeId } = require("../services/whatsappService");
const { MAX_MESSAGES_PER_CHAT } = require("../services/userService");

router.get("/", async (req, res) => {
  const accountId = normalizeId(req.query.accountId);
  try {
    let users = [];
    try {
      users = await User.find({ accountId, archived: { $ne: true } }).sort({ pinned: -1, updatedAt: -1 }).lean();
    } catch (_) {}
    res.json({ success: true, users: users || [] });
  } catch (err) { res.json({ success: true, users: [] }); }
});

router.get("/archived", async (req, res) => {
  const accountId = normalizeId(req.query.accountId);
  try {
    let users = [];
    try {
      users = await User.find({ accountId, archived: true }).sort({ updatedAt: -1 }).lean();
    } catch (_) {}
    res.json({ success: true, users: users || [] });
  } catch (err) { res.json({ success: true, users: [] }); }
});

router.get("/search/:number", async (req, res) => {
  const accountId = normalizeId(req.query.accountId);
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ success: true, chats: [] });
    let chats = [];
    try {
      chats = await Chat.find({ accountId, number: req.params.number, message: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } })
        .sort({ createdAt: -1 }).limit(50).lean();
    } catch (_) {}
    res.json({ success: true, chats: chats || [] });
  } catch (err) { res.json({ success: true, chats: [] }); }
});

router.get("/:number/count", async (req, res) => {
  const accountId = normalizeId(req.query.accountId);
  try {
    const number = String(req.params.number || "");
    let count = 0;
    let latest = [];
    try {
      count = await Chat.countDocuments({ accountId, number });
      latest = await Chat.find({ accountId, number }).sort({ createdAt: -1 }).limit(3).lean();
    } catch (_) {}
    res.json({ success: true, count: count || 0, latest: latest || [] });
  } catch (err) {
    res.json({ success: true, count: 0, latest: [] });
  }
});

router.get("/:number", async (req, res) => {
  const accountId = normalizeId(req.query.accountId);
  const number = String(req.params.number || "");
  try {
    let chats = [];
    try {
      chats = await Chat.find({ accountId, number }).sort({ createdAt: -1 }).limit(MAX_MESSAGES_PER_CHAT).lean();
      if (chats && chats.length) chats.reverse();
    } catch (_) {}
    res.json({ success: true, chats: chats || [], stored: (chats || []).length > 0 });
  } catch (err) {
    res.json({ success: true, chats: [], stored: false });
  }
});


router.patch("/user/:number", async (req, res) => {
  const accountId = normalizeId(req.query.accountId);
  try {
    const allowed = ["pinned", "starred", "archived", "muted", "aiEnabled", "aiMemory", "aiPersonality", "aiInstructions", "aiLanguage", "aiReplyLength", "autoReply", "humanTakeover", "excludedFromAI", "replyDelayMin", "replyDelayMax"];
    const update = {};
    allowed.forEach(k => {
      if (["pinned", "starred", "archived", "muted", "aiEnabled", "aiMemory", "autoReply", "humanTakeover", "excludedFromAI"].includes(k) && typeof req.body?.[k] === "boolean") update[k] = req.body[k];
      if (["replyDelayMin", "replyDelayMax"].includes(k) && Number.isFinite(Number(req.body?.[k]))) update[k] = Math.max(0, Math.min(120, Number(req.body[k])));
      if (k === "aiPersonality" && ["friendly","professional","casual","concise","creative"].includes(req.body?.[k])) update[k] = req.body[k];
      if (k === "aiInstructions" && typeof req.body?.[k] === "string") update[k] = req.body[k].trim().slice(0,1000);
      if (k === "aiLanguage" && ["auto","english","hindi","hinglish","bhojpuri"].includes(req.body?.[k])) update[k] = req.body[k];
      if (k === "aiReplyLength" && ["short","balanced","detailed"].includes(req.body?.[k])) update[k] = req.body[k];
    });
    const user = await User.findOneAndUpdate({ accountId, number: req.params.number }, { $set: update }, { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }).lean();
    res.json({ success: true, user });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post("/message/:id/reaction", async (req, res) => {
  try {
    const chat = await Chat.findById(req.params.id);
    if (!chat) return res.status(404).json({ success: false, message: "Message not found" });
    chat.reaction = String(req.body?.reaction || "").slice(0, 8);
    await chat.save();
    res.json({ success: true, reaction: chat.reaction });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete("/message/:id", async (req, res) => {
  try {
    const chat = await Chat.findById(req.params.id);
    if (!chat) return res.status(404).json({ success: false, message: "Message not found" });
    chat.deleted = true; chat.message = "This message was deleted"; chat.mediaUrl = "";
    await chat.save();
    const io = req.app.get("io");
    if (io) io.emit("messageDeleted", { id: chat._id.toString(), number: chat.number });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.patch("/:number/read", async (req, res) => {
  const accountId = normalizeId(req.query.accountId);
  try {
    await Chat.updateMany({ accountId, number: req.params.number, sender: { $ne: "user" }, status: { $ne: "read" } }, { $set: { status: "read" } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete("/:number", async (req, res) => {
  const accountId = normalizeId(req.query.accountId);
  try {
    const result = await Chat.deleteMany({ accountId, number: req.params.number });
    const io = req.app.get("io");
    if (io) io.emit("chatCleared", { accountId, number: req.params.number });
    res.json({ success: true, message: "Chat cleared successfully", deletedCount: result.deletedCount });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;

