const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || '';
mongoose.set('bufferCommands', false);
mongoose.set('bufferTimeoutMS', 3000);

async function connectDB() {
  if (!MONGO_URI) {
    console.log('ℹ️ Running in fast in-memory storage mode (MONGO_URI not configured).');
    return null;
  }

  if (mongoose.connection.readyState === 1) return mongoose.connection;

  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 3000),
      connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 3000),
      socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 5000),
      maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 5),
      minPoolSize: 0,
      maxIdleTimeMS: 30000,
    });
    console.log('✅ MongoDB connected successfully');
    return mongoose.connection;
  } catch (err) {
    console.warn(`ℹ️ MongoDB connection not available (${err.message}). Continuing in resilient In-Memory mode.`);
    return null;
  }
}

function isDatabaseReady() {
  return mongoose.connection.readyState === 1;
}

module.exports = connectDB;
module.exports.isDatabaseReady = isDatabaseReady;
module.exports.MONGO_URI = MONGO_URI;
