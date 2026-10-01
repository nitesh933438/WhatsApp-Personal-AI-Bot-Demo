const mongoose = require("mongoose");

const NoteSchema = new mongoose.Schema({

    number: {
        type: String,
        required: true
    },

    note: {
        type: String,
        required: true
    },

    createdBy: {
        type: String,
        default: "Admin"
    }

}, {
    timestamps: true
});

module.exports = mongoose.model("Note", NoteSchema);