"use strict";
const Chat = require("../models/Chat");
const User = require("../models/User");
const norm = (id) => String(id || "default");

/**
 * Generate a conversation report for an account.
 */
async function generateReport(accountId = "default", options = {}) {
  const aid = norm(accountId);
  const { startDate, endDate, type = "summary" } = options;

  const matchQuery = { accountId: aid };
  if (startDate || endDate) {
    matchQuery.createdAt = {};
    if (startDate) matchQuery.createdAt.$gte = new Date(startDate);
    if (endDate) matchQuery.createdAt.$lte = new Date(endDate);
  }

  const [totalMessages, totalContacts, botMessages, adminMessages, topContacts] = await Promise.all([
    Chat.countDocuments(matchQuery),
    User.countDocuments({ accountId: aid }),
    Chat.countDocuments({ ...matchQuery, sender: "bot" }),
    Chat.countDocuments({ ...matchQuery, sender: "admin" }),
    Chat.aggregate([
      { $match: matchQuery },
      { $group: { _id: "$number", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ])
  ]);

  return {
    accountId: aid,
    type,
    generatedAt: new Date().toISOString(),
    period: { startDate: startDate || null, endDate: endDate || null },
    summary: {
      totalMessages,
      totalContacts,
      botMessages,
      adminMessages,
      topContacts
    }
  };
}

module.exports = { generateReport };
