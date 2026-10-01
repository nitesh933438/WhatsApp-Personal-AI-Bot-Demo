const Tag = require("../models/Tag");

exports.getTags = async (req, res) => {
    try {
        let tags = [];
        try {
            tags = await Tag.find().lean();
        } catch (_) {}
        if (!tags || !tags.length) {
            tags = [
                { _id: "1", name: "VIP", color: "#19b56d" },
                { _id: "2", name: "Lead", color: "#00a884" },
                { _id: "3", name: "Customer", color: "#3498db" }
            ];
        }
        res.json(tags);
    } catch (err) {
        res.json([
            { _id: "1", name: "VIP", color: "#19b56d" },
            { _id: "2", name: "Lead", color: "#00a884" },
            { _id: "3", name: "Customer", color: "#3498db" }
        ]);
    }
};