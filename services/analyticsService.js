"use strict";
const Chat = require("../models/Chat");
const User = require("../models/User");
const norm = (id) => String(id || "default");

/**
 * Get aggregated analytics for an account.
 * Returns message counts, active contacts, and daily breakdown.
 */
async function getAnalytics(accountId = "default") {
  const aid = norm(accountId);
  const [totalMessages, totalContacts, aiReplies, recentActivity] = await Promise.all([
    Chat.countDocuments({ accountId: aid }),
    User.countDocuments({ accountId: aid }),
    Chat.countDocuments({ accountId: aid, sender: "bot" }),
    Chat.aggregate([
      { $match: { accountId: aid } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: -1 } },
      { $limit: 30 }
    ])
  ]);

  return {
    totalMessages,
    totalContacts,
    aiReplies,
    humanReplies: await Chat.countDocuments({ accountId: aid, sender: "admin" }),
    recentActivity: recentActivity.reverse()
  };
}

module.exports = { getAnalytics };
