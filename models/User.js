const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({

    accountId: { type: String, default: "default", index: true },

    number: {
        type: String,
        required: true,
        index: true
    },

    name: {
        type: String,
        default: "User"
    },

    profilePic: {
        type: String,
        default: ""
    },

    tag: {
        type: String,
        default: "New Lead"
    },

    status: {
        type: String,
        default: "Active"
    },

    totalMessages: {
        type: Number,
        default: 0
    },

    aiReplies: {
        type: Number,
        default: 0
    },

    lastMessage: {
        type: String,
        default: ""
    },

    lastSeen: {
        type: Date,
        default: Date.now
    },

    lastGreetingAt: {
        type: Date,
        default: null
    },

    pinned: {
        type: Boolean,
        default: false
    },

    starred: {
        type: Boolean,
        default: false
    },

    archived: {
        type: Boolean,
        default: false
    },

    muted: {
        type: Boolean,
        default: false
    },

    aiEnabled: {
        type: Boolean,
        default: true
    },

    aiMemory: {
        type: Boolean,
        default: true
    },

    aiPersonality: {
        type: String,
        default: "friendly",
        enum: ["friendly", "professional", "casual", "concise", "creative"]
    },

    aiInstructions: {
        type: String,
        default: "",
        maxlength: 1000
    },

    aiLanguage: {
        type: String,
        default: "auto",
        enum: ["auto", "english", "hindi", "hinglish", "bhojpuri"]
    },

    aiReplyLength: {
        type: String,
        default: "balanced",
        enum: ["short", "balanced", "detailed"]
    },

    conversationSummary: {
        type: String,
        default: "",
        maxlength: 5000
    },

    summaryUpdatedAt: {
        type: Date,
        default: null
    },

    autoReply: { type: Boolean, default: true },

    humanTakeover: { type: Boolean, default: false },

    excludedFromAI: { type: Boolean, default: false },

    replyDelayMin: { type: Number, default: 0, min: 0, max: 120 },

    replyDelayMax: { type: Number, default: 2, min: 0, max: 120 }

}, {
    timestamps: true
});

UserSchema.index({ accountId: 1, number: 1 }, { unique: true });
module.exports = mongoose.model("User", UserSchema);
