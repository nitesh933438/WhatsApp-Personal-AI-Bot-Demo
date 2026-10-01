const Note = require("../models/Note");

const memoryNotes = new Map();

// Get Notes
exports.getNotes = async (req, res) => {
    try {
        let notes = [];
        try {
            notes = await Note.find({
                number: req.params.number
            }).sort({
                createdAt: -1
            }).lean();
        } catch (_) {}

        if (!notes || !notes.length) {
            notes = memoryNotes.get(req.params.number) || [];
        }

        res.json(notes);
    } catch (err) {
        res.json(memoryNotes.get(req.params.number) || []);
    }
};

// Save Note
exports.saveNote = async (req, res) => {
    try {
        let saved = false;
        try {
            const note = new Note(req.body);
            await note.save();
            saved = true;
        } catch (_) {}

        const number = req.body?.number || req.params.number;
        if (number) {
            const list = memoryNotes.get(number) || [];
            list.unshift({ ...req.body, createdAt: new Date().toISOString() });
            memoryNotes.set(number, list);
        }

        res.json({
            success: true
        });
    } catch (err) {
        res.json({
            success: true
        });
    }
};