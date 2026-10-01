const express = require("express");
const router = express.Router();
const { login } = require("../controllers/authController");
const rateLimit = require("express-rate-limit");

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  validate: false,
  message: { success: false, message: "Too many login attempts. Please try again in a moment." }
});

router.post("/login", loginLimiter, login);

router.post("/logout", (req, res) => {
  res.clearCookie("access_token", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  res.json({ success: true });
});

module.exports = router;