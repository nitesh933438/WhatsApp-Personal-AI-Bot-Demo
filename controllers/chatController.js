const Chat = require("../models/Chat");
const { normalizeId } = require("../services/whatsappService");
const { MAX_MESSAGES_PER_CHAT } = require("../services/userService");

const memoryChats = new Map();

// Get Chat History
exports.getChat = async (req, res) => {
    try {
        const accountId = normalizeId(req.query.accountId || "default");
        const query = {
            accountId,
            number: req.params.number
        };

        let chats = [];
        try {
            chats = await Chat.find(query)
                .sort({ createdAt: -1 })
                .limit(MAX_MESSAGES_PER_CHAT)
                .lean();
            chats.reverse();
        } catch (_) {}

        if (!chats || !chats.length) {
            const key = `${accountId}:${req.params.number}`;
            chats = memoryChats.get(key) || [];
        }

        res.json({
            success: true,
            chats,
            stored: chats.length > 0
        });
    } catch (err) {
        res.json({
            success: true,
            chats: [],
            stored: false
        });
    }
};

// Clear Chat History
exports.clearChat = async (req, res) => {
    try {
        const accountId = normalizeId(req.query.accountId || "default");
        const query = {
            accountId,
            number: req.params.number
        };

        let deletedCount = 0;
        try {
            const result = await Chat.deleteMany(query);
            deletedCount = result.deletedCount;
        } catch (_) {}

        const key = `${accountId}:${req.params.number}`;
        memoryChats.delete(key);

        const io = req.app.get("io");
        if (io) io.emit("chatCleared", { accountId, number: req.params.number });

        res.json({
            success: true,
            message: "Chat cleared successfully",
            deletedCount
        });
    } catch (err) {
        res.json({
            success: true,
            message: "Chat cleared successfully",
            deletedCount: 0
        });
    }
};