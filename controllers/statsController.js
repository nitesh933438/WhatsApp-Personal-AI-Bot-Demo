const Stats = require("../models/Stats");

exports.getStats = async (req, res) => {
  try {
    let stats = null;
    try {
      stats = await Stats.findOne().lean();
    } catch (_) {}
    if (!stats) stats = { totalMessages: 0, totalBroadcasts: 0, todayMessages: 0, totalUsers: 0 };
    res.json(stats);
  } catch (err) {
    res.json({ totalMessages: 0, totalBroadcasts: 0, todayMessages: 0, totalUsers: 0 });
  }
};
