const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");

function applySecurity(app) {
  app.use(helmet({
    frameguard: false,
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    referrerPolicy: { policy: "no-referrer-when-downgrade" }
  }));
  app.use(cors({ origin: true, credentials: true }));
  app.use(compression());
}
module.exports = applySecurity;
