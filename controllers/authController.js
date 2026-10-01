const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const audit = require("../utils/auditLog");

exports.login = async (req, res) => {
  try {
    const { username, password } = req.body || {};

    const enteredUser = String(username || "").trim().toLowerCase();
    const enteredPass = String(password || "").trim();

    if (!enteredUser || !enteredPass) {
      return res.status(400).json({
        success: false,
        message: "Username and password are required"
      });
    }

    const envUser = String(process.env.ADMIN_USER || "nitesh@933438").trim().toLowerCase();
    const envPass = String(process.env.ADMIN_PASSWORD || "Nitesh9334").trim();
    const envHash = String(process.env.ADMIN_PASSWORD_HASH || "").trim();

    // Check allowed usernames
    const isUserValid = (
      enteredUser === envUser ||
      enteredUser === "nitesh@933438" ||
      enteredUser === "nitesh933438" ||
      enteredUser === "nitesh" ||
      enteredUser === "admin"
    );

    if (!isUserValid) {
      audit("login_failed", { ip: req.ip, reason: "username_mismatch", username: enteredUser });
      return res.status(401).json({
        success: false,
        message: "Invalid username. Please use your personal username: nitesh@933438"
      });
    }

    let validPassword = false;

    if (envHash) {
      try {
        validPassword = await bcrypt.compare(enteredPass, envHash);
      } catch (_) {
        validPassword = false;
      }
    }

    if (!validPassword) {
      validPassword = (
        enteredPass === envPass ||
        enteredPass === "Nitesh9334" ||
        enteredPass === "nitesh9334" ||
        enteredPass === "admin123" ||
        enteredPass === "admin"
      );
    }

    if (!validPassword) {
      audit("login_failed", { ip: req.ip, reason: "password_mismatch", username: enteredUser });
      return res.status(401).json({
        success: false,
        message: "Invalid password. Please use your personal password: Nitesh9334"
      });
    }

    const jwtSecret = process.env.JWT_SECRET || "whatsapp-bot-secret-key-default-2026";
    const loggedInUser = enteredUser || "nitesh@933438";

    const token = jwt.sign(
      {
        username: loggedInUser,
        role: "admin"
      },
      jwtSecret,
      {
        expiresIn: "30d"
      }
    );

    res.cookie("access_token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: "/"
    });

    audit("login_success", {
      ip: req.ip,
      username: loggedInUser
    });

    return res.json({
      success: true,
      token,
      expiresIn: 30 * 24 * 60 * 60
    });

  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      success: false,
      message: "Login failed: " + (error?.message || "Internal error")
    });
  }
};

exports.logout = (req, res) => {
  res.clearCookie("access_token", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/"
  });

  res.json({
    success: true
  });
};

