const express = require("express");

const router = express.Router();

const Chat = require("../models/Chat");

router.get("/", async (req, res) => {
    try {
        const chats = await Chat.find().sort({ createdAt: 1 }).lean();
        res.json(chats || []);
    } catch (err) {
        res.json([]);
    }
});

module.exports = router;