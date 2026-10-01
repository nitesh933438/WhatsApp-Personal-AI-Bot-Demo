require('dotenv').config();

const mods = [
  '../models/User',
  '../models/Chat',
  '../models/Note',
  '../models/Stats',
  '../models/Tag',
  '../models/WhatsAppAccount',
  '../models/AIMemory',
  '../models/Broadcast',
  '../models/Notification',
  '../models/PushSubscription',
  '../models/Report',
  '../models/Settings',
  '../controllers/authController',
  '../controllers/userController',
  '../controllers/chatController',
  '../controllers/dashboardController',
  '../controllers/noteController',
  '../controllers/tagController',
  '../controllers/statsController',
  '../controllers/broadcastController',
  '../controllers/analyticsController',
  '../controllers/reportController',
  '../controllers/settingsController',
  '../services/userService',
  '../services/broadcastService',
  '../services/pushService',
  '../services/analyticsService',
  '../services/chatService',
  '../services/reportService',
  '../utils/asyncHandler',
  '../utils/auditLog',
  '../utils/backup',
  '../utils/constants',
  '../utils/date',
  '../utils/greeting',
  '../utils/helpers',
  '../utils/logger',
  '../utils/offlineReplies',
  '../utils/response',
  '../utils/validators',
  '../middleware/authMiddleware',
  '../middleware/errorHandler',
  '../middleware/rateLimiter',
  '../middleware/security',
  '../middleware/requestSecurity',
  '../middleware/logger',
  '../middleware/validate',
  '../middleware/admin',
  '../middleware/auth',
  '../middleware/upload',
  '../config/database',
  '../socket',
];

let ok = 0;
let fail = 0;

for (const m of mods) {
  try {
    require(m);
    console.log('✅ OK:', m);
    ok++;
  } catch (e) {
    console.error('❌ FAIL:', m, '->', e.message);
    fail++;
  }
}

console.log('\n=========================');
console.log('Results: OK=' + ok + ', FAIL=' + fail);
console.log('=========================');

process.exit(fail > 0 ? 1 : 0);
