"use strict";
const Chat = require("../models/Chat");
const User = require("../models/User");
const norm = (id) => String(id || "default");

/**
 * Get full chat history for a contact.
 */
async function getChatHistory(number, accountId = "default", limit = 100) {
  const aid = norm(accountId);
  return Chat.find({ accountId: aid, number })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean()
    .then((msgs) => msgs.reverse());
}

/**
 * Get a paginated list of contacts with their latest message.
 */
async function getContacts(accountId = "default") {
  return User.find({ accountId: norm(accountId) })
    .sort({ pinned: -1, updatedAt: -1 })
    .lean();
}

/**
 * Search messages by text query.
 */
async function searchMessages(query, accountId = "default", limit = 50) {
  return Chat.find({
    accountId: norm(accountId),
    message: { $regex: query, $options: "i" }
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

module.exports = { getChatHistory, getContacts, searchMessages };
