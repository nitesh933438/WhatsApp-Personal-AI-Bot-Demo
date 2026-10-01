const crypto = require('crypto');
const auth = require('./authMiddleware');

module.exports = function requestSecurity(req, res, next) {
  const id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', id);
  req.requestId = id;
  // Authentication is required for all application APIs and legacy write routes.
  const publicPaths = [
    '/api/auth/login',
    '/api/app/version',
    '/api/ai/status',
    '/api/status',
    '/login',
    '/healthz',
    '/readyz'
  ];
  const publicApi = publicPaths.includes(req.path) || req.path.startsWith('/api/auth/');
  const protectedRoute = req.path.startsWith('/api/') || ['/send','/broadcast','/users','/history','/stats','/report'].includes(req.path);
  if (protectedRoute && !publicApi) return auth(req, res, next);
  next();
};

