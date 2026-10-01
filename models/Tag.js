const mongoose = require("mongoose");

const TagSchema = new mongoose.Schema({

    name: {
        type: String,
        required: true,
        unique: true
    },

    color: {
        type: String,
        default: "#25D366"
    }

});

module.exports = mongoose.model("Tag", TagSchema);