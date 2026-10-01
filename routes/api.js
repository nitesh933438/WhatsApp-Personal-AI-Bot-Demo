const express = require("express");

const router = express.Router();

const dashboard = require("../controllers/dashboardController");

const users = require("../controllers/userController");

const chats = require("../controllers/chatController");

// Dashboard

router.get("/dashboard", dashboard.getDashboard);

// Users

router.get("/users", users.getUsers);

router.get("/users/:number", users.getUser);

router.delete("/users/:number", users.deleteUser);

// Chat

router.get("/chat/:number", chats.getChat);

router.delete("/chat/:number", chats.clearChat);

module.exports = router;