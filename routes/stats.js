const express = require("express");

const router = express.Router();

const Stats = require("../models/Stats");

router.get("/", async (req, res) => {
    try {
        let stats = await Stats.findOne().lean();
        if (!stats) {
            stats = {
                totalMessages: 0,
                totalBroadcasts: 0
            };
        }
        res.json(stats);
    } catch (err) {
        res.json({
            totalMessages: 0,
            totalBroadcasts: 0
        });
    }
});

module.exports = router;