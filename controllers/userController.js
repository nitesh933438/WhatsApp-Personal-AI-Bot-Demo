const User = require("../models/User");
const { normalizeId } = require("../services/whatsappService");

// In-memory fallback users
const memoryUsers = new Map();

// Get All Users
exports.getUsers = async (req, res) => {
    try {
        const accountId = normalizeId(req.query.accountId || "default");
        let users = [];
        try {
            users = await User.find({ accountId }).sort({ updatedAt: -1 }).lean();
        } catch (_) {}
        if (!users || !users.length) {
            users = [...memoryUsers.values()].filter(u => u.accountId === accountId);
        }
        res.json(users || []);
    } catch (err) {
        res.json([]);
    }
};

// Get Single User
exports.getUser = async (req, res) => {
    try {
        const accountId = normalizeId(req.query.accountId || "default");
        let user = null;
        try {
            user = await User.findOne({
                accountId,
                number: req.params.number
            }).lean();
        } catch (_) {}
        if (!user) {
            user = memoryUsers.get(`${accountId}:${req.params.number}`);
        }
        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User Not Found"
            });
        }
        res.json(user);
    } catch (err) {
        res.status(404).json({
            success: false,
            message: "User Not Found"
        });
    }
};

// Delete User
exports.deleteUser = async (req, res) => {
    try {
        const accountId = normalizeId(req.query.accountId || "default");
        try {
            await User.findOneAndDelete({
                accountId,
                number: req.params.number
            });
        } catch (_) {}
        memoryUsers.delete(`${accountId}:${req.params.number}`);

        res.json({
            success: true,
            message: "User deleted successfully"
        });
    } catch (err) {
        res.json({
            success: true,
            message: "User deleted successfully"
        });
    }
};