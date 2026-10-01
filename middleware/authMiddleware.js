const jwt = require("jsonwebtoken");

function getToken(req) {
  const header = String(req.headers.authorization || "");
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  if (header) return header.trim();
  const cookie = String(req.cookies?.access_token || "").trim();
  if (cookie) return cookie;
  return String(req.query?.token || "").trim();
}

module.exports = (req, res, next) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ success: false, message: "Unauthorized" });
  const secret = process.env.JWT_SECRET || "whatsapp-bot-secret-key-default-2026";
  try {
    const payload = jwt.verify(token, secret);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: err.name === "TokenExpiredError" ? "Session expired" : "Invalid Token" });
  }
};
