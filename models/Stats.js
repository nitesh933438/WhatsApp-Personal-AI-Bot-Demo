const mongoose = require("mongoose");

const StatsSchema = new mongoose.Schema({

    totalMessages: {

        type: Number,

        default: 0

    },

    totalBroadcasts: {

        type: Number,

        default: 0

    }

});

module.exports = mongoose.model("Stats", StatsSchema);