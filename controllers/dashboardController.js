const User = require("../models/User");
const Chat = require("../models/Chat");
const Stats = require("../models/Stats");

exports.getDashboard = async (req, res) => {
    try {
        let totalUsers = 0;
        let totalChats = 0;
        let stats = null;
        let latestUsers = [];

        try {
            totalUsers = await User.countDocuments();
            totalChats = await Chat.countDocuments();
            stats = await Stats.findOne();
            latestUsers = await User.find()
                .sort({ updatedAt: -1 })
                .limit(5)
                .lean();
        } catch (dbErr) {
            console.warn("MongoDB unavailable in dashboardController:", dbErr.message);
        }

        res.json({
            success: true,
            totalUsers: totalUsers || 0,
            totalChats: totalChats || 0,
            totalMessages: stats?.totalMessages || 0,
            totalBroadcasts: stats?.totalBroadcasts || 0,
            latestUsers: latestUsers || []
        });
    } catch (err) {
        res.json({
            success: true,
            totalUsers: 0,
            totalChats: 0,
            totalMessages: 0,
            totalBroadcasts: 0,
            latestUsers: []
        });
    }
};