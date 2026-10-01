const rateLimit = require('express-rate-limit');

// The app shell, CSS, JS, images, PWA assets and read-only API polling must not
// consume the write/API request budget. The login route has its own stricter
// limiter in routes/auth.js. This limiter protects state-changing endpoints
// and unexpected request floods without making the dashboard unusable.
module.exports = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  validate: false,
  skip: req => {
    if (req.path === '/api/auth/login') return true;
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
    if (req.path.startsWith('/socket.io')) return true;
    if (!req.path.startsWith('/api') && !req.path.startsWith('/send') && !req.path.startsWith('/broadcast')) return true;
    return false;
  }
});
