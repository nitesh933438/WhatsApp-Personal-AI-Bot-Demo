
require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");
const jwt = require("jsonwebtoken");

const connectDB = require("./config/database");
const mongoose = require("mongoose");
const limiter = require("./middleware/rateLimiter");
const applySecurity = require("./middleware/security");
const logger = require("./middleware/logger");
const errorHandler = require("./middleware/errorHandler");
const { initializeSocket, getIO } = require("./socket");
const {
  initializeWhatsApp,
  getClient,
  listAccounts,
  setRuntimeHandlers,
  getRuntimeHealth,
  disconnectWhatsApp
} = require("./services/whatsappService");
const WhatsAppAccount = require("./models/WhatsAppAccount");
const { getAIReply } = require("./services/aiService");
const {
  pruneAllChatHistories,
  MAX_MESSAGES_PER_CHAT
} = require("./services/userService");
const { registerMessageHandler } = require("./handlers/messageHandler");
const requestSecurity = require("./middleware/requestSecurity");

let shuttingDown = false;

process.on("unhandledRejection", (reason) => {
  console.error(
    "❌ Unhandled promise rejection:",
    reason?.stack || reason?.message || reason
  );
});

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught exception:", err?.stack || err?.message || err);
  setTimeout(() => process.exit(1), 50).unref();
});

const app = express();

app.set("trust proxy", 1);

const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

const jwtSecret = process.env.JWT_SECRET || "whatsapp-bot-secret-key-default-2026";
if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = "whatsapp-bot-session-secret-default-2026";
}

app.use(logger);
app.use(compression());
app.use(morgan("dev"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Cookie parser
app.use((req, _res, next) => {
  const raw = req.headers.cookie || "";
  req.cookies = {};

  raw.split(";").forEach((part) => {
    const i = part.indexOf("=");

    if (i > 0) {
      try {
        req.cookies[part.slice(0, i).trim()] =
          decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        // Ignore malformed cookie values.
      }
    }
  });

  next();
});

app.use(limiter);
applySecurity(app);
initializeSocket(server);
app.set("io", getIO());

// Check whether the existing login cookie contains a valid JWT.
function hasValidLogin(req) {
  const token = String(req.cookies?.access_token || "").trim();
  const secret = process.env.JWT_SECRET || "whatsapp-bot-secret-key-default-2026";

  if (!token) return false;

  try {
    const payload = jwt.verify(token, secret);
    return Boolean(payload && payload.role === "admin");
  } catch {
    return false;
  }
}

// Authentication pages
app.get(["/login", "/auth", "/login.html"], (req, res) => {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0"
  });

  return res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Root page
app.get("/", (req, res) => {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0"
  });

  if (hasValidLogin(req)) {
    return res.redirect(302, "/dashboard.html");
  }

  return res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Chat UI
app.get("/chat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "chat.html"), {
    headers: {
      "Cache-Control": "no-store"
    }
  });
});

// Static files
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders(res, filePath) {
      if (filePath.endsWith("/login.html")) {
        res.setHeader(
          "Cache-Control",
          "no-store, no-cache, must-revalidate, private"
        );
      }
    }
  })
);

app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(requestSecurity);

app.get("/chat.html", (req, res) => {
  res.status(404).json({
    success: false,
    message: "Legacy chat URL removed. Use /chat."
  });
});

// Routes
app.use("/", require("./routes/auth"));
app.use("/users", require("./routes/users"));
app.use("/history", require("./routes/history"));
app.use("/stats", require("./routes/stats"));
app.use("/report", require("./routes/report"));
app.use("/broadcast", require("./routes/broadcast"));
app.use("/chat", require("./routes/chat"));
app.use("/send", require("./routes/send"));

app.use("/api/users", require("./routes/users"));
app.use("/api/chat", require("./routes/chat"));
app.use("/api/notes", require("./routes/notes"));
app.use("/api/tags", require("./routes/tags"));
app.use("/api/auth", require("./routes/auth"));
app.use("/api/memory", require("./routes/memory"));
app.use("/api/whatsapp/accounts", require("./routes/accounts"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api/runtime", require("./routes/runtime"));
app.use("/api", require("./routes/api"));


// Health check
app.get("/healthz", (req, res) => {
  res.status(shuttingDown ? 503 : 200).json({
    ok: !shuttingDown,
    service: "whatsapp-personal-bot",
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// Readiness check
app.get("/readyz", (req, res) => {
  const dbReady = mongoose.connection.readyState === 1;
  const ready =
    !shuttingDown &&
    (process.env.NODE_ENV !== "production" || dbReady);

  res.status(ready ? 200 : 503).json({
    ready,
    database: dbReady ? "ready" : "not-ready",
    whatsapp: getRuntimeHealth(),
    timestamp: new Date().toISOString()
  });
});

// AI status
app.get("/api/ai/status", (req, res) => {
  const configured = Boolean(
    String(process.env.GEMINI_API_KEY || "").trim() ||
    String(process.env.OPENAI_API_KEY || "").trim() ||
    /^(1|true|yes)$/i.test(
      String(process.env.OLLAMA_ENABLED || "false")
    )
  );

  res.set("Cache-Control", "no-store");

  res.json({
    success: true,
    configured,
    geminiConfigured: Boolean(
      String(process.env.GEMINI_API_KEY || "").trim()
    ),
    openaiConfigured: Boolean(
      String(process.env.OPENAI_API_KEY || "").trim()
    ),
    ollamaEnabled: /^(1|true|yes)$/i.test(
      String(process.env.OLLAMA_ENABLED || "false")
    )
  });
});

// App version
app.get("/api/app/version", (req, res) => {
  try {
    const pkg = require("./package.json");
    res.set("Cache-Control", "no-store");

    res.json({
      success: true,
      version: pkg.version || "1.0.0",
      name: pkg.name || "whatsapp-personal-bot"
    });
  } catch (_) {
    res.json({
      success: true,
      version: "1.0.0",
      name: "whatsapp-personal-bot"
    });
  }
});

// WhatsApp status
app.get("/api/status", (req, res) => {
  const accountId = req.query.accountId || "default";

  res.json({
    success: true,
    server: "Running",
    time: new Date().toISOString(),
    whatsapp: !!getClient(accountId),
    whatsappStatus: require("./services/whatsappService").getStatus(
      accountId
    )
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route Not Found"
  });
});

app.use(errorHandler);

// WhatsApp runtime handlers
setRuntimeHandlers({
  io: getIO(),
  onReady: (client, id) =>
    registerMessageHandler(
      client,
      getAIReply,
      process.env.ADMIN_NUMBER,
      getIO(),
      id
    )
});

// Normalize account ID for startup
function normalizeAccountIdForStartup(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 50);
}

// Start WhatsApp accounts
async function bootWhatsAppAccounts() {
  const autoStart = /^(1|true|yes)$/i.test(
    String(process.env.WHATSAPP_AUTO_START || "false")
  );

  const configured = autoStart
    ? String(process.env.WHATSAPP_ACCOUNT_IDS || "default")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

  try {
    const dbAccounts = await WhatsAppAccount.find()
      .sort({ createdAt: 1 })
      .lean();

    const autoStartAll = /^(1|true|yes)$/i.test(
      String(process.env.WHATSAPP_AUTO_START_ALL || "false")
    );

    const requested = autoStartAll
      ? dbAccounts.map((a) => a?.accountId).filter(Boolean)
      : configured;

    for (const id of requested) {
      if (id && !configured.includes(id)) {
        configured.push(id);
      }
    }
  } catch (err) {
    console.warn(
      "⚠️ Could not load WhatsApp accounts from MongoDB:",
      err.message
    );
  }

  const unique = [
    ...new Set(
      configured.map(normalizeAccountIdForStartup).filter(Boolean)
    )
  ];

  console.log(
    `📲 WhatsApp auto-start: ${
      autoStart
        ? unique.join(", ") || "none"
        : "disabled — use Connect from dashboard"
    }`
  );

  const delayMs = Math.max(
    0,
    Number(process.env.WHATSAPP_START_DELAY_MS || 10000)
  );

  for (let i = 0; i < unique.length; i += 1) {
    const accountId = unique[i];

    try {
      initializeWhatsApp(accountId);
    } catch (err) {
      console.error(
        `❌ Failed to initialize WhatsApp [${accountId}]:`,
        err
      );
    }

    if (i < unique.length - 1 && delayMs) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// Chat retention cleanup
let retentionTimer = null;

function startChatRetentionCleanup() {
  const hours = Math.max(
    1,
    Number(process.env.CHAT_RETENTION_CLEANUP_HOURS || 6)
  );

  const run = async () => {
    try {
      const result = await pruneAllChatHistories();

      if (result?.deleted) {
        console.log(
          `🧹 Chat retention cleanup: removed ${result.deleted} old messages across ${result.contacts} contacts (limit ${MAX_MESSAGES_PER_CHAT}/contact)`
        );
      }
    } catch (err) {
      console.warn(
        "⚠️ Chat retention cleanup failed:",
        err?.message || err
      );
    }
  };

  void run();

  retentionTimer = setInterval(
    run,
    hours * 60 * 60 * 1000
  );

  retentionTimer.unref?.();

  console.log(
    `🗃️ Chat retention: max ${MAX_MESSAGES_PER_CHAT} messages/contact; automatic cleanup every ${hours}h`
  );
}

// Bootstrap
async function bootstrap() {
  try {
    await connectDB();
  } catch (err) {
    console.warn("ℹ️ Running in resilient In-Memory mode:", err.message);
  }

  try {
    startChatRetentionCleanup();
  } catch (_) {}

  await bootWhatsAppAccounts();
}

// Graceful shutdown
const shutdown = async (signal) => {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log(
    `\n🛑 ${signal} received — graceful shutdown starting...`
  );

  const forceExit = setTimeout(() => {
    console.error("⚠️ Graceful shutdown timed out; forcing exit.");
    process.exit(1);
  }, Number(process.env.SHUTDOWN_TIMEOUT_MS || 15000));

  forceExit.unref();

  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }

  try {
    await Promise.allSettled(
      (await listAccounts()).map((a) =>
        disconnectWhatsApp(a.accountId, {
          reason: `Server shutdown: ${signal}`
        })
      )
    );
  } catch (err) {
    console.error("WhatsApp shutdown warning:", err.message);
  }

  await new Promise((resolve) => server.close(resolve));

  try {
    await mongoose.connection.close(false);
  } catch (err) {
    console.error("MongoDB shutdown warning:", err.message);
  }

  clearTimeout(forceExit);

  console.log("✅ Shutdown complete.");
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Start server
server.listen(PORT, "0.0.0.0", () => {
  console.log("=====================================");
  console.log("🚀 WhatsApp Personal Bot Started");
  console.log(`🌐 http://localhost:${PORT}`);
  console.log(`❤️  Health: http://localhost:${PORT}/healthz`);
  console.log(`🩺 Ready:  http://localhost:${PORT}/readyz`);
  console.log("=====================================");

  bootstrap().catch((err) => {
    console.error("❌ Startup bootstrap failed:", err);
  });
});