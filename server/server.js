require('dotenv').config();

const app = require('./app');
const connectDB = require('./config/db');
const mongoose = require('mongoose');
const { ensureIndexes } = require('./config/ensure-indexes');
const { expireBreakGlassAuthorizations } = require('./services/break-glass-expiration.service');
const port = Number(process.env.PORT) || 5000;
let httpServer;
let isShuttingDown = false;

async function startServer() {
  try {
    await connectDB();
    const indexResult = await ensureIndexes();
    console.log(`MongoDB indexes ready for ${indexResult.modelCount} models`);

    let expirationResult;
    try {
      expirationResult = await expireBreakGlassAuthorizations();
    } catch (_) {
      console.error('Server startup aborted: initial BreakGlass expiration failed.');
      throw new Error('Initial BreakGlass expiration failed');
    }

    console.log(`Initial BreakGlass expiration completed; records expired: ${expirationResult.expiredCount}`);
    httpServer = app.listen(port, () => {
      console.log(`Hospital EMR API listening on port ${port}`);
    });
    return httpServer;
  } catch (error) {
    if (error?.name === 'IndexReadinessError') {
      console.error(`Server startup aborted: MongoDB indexes are not ready for ${error.modelName}.`);
    } else if (error?.message !== 'Initial BreakGlass expiration failed') {
      console.error('Server startup aborted: database initialization failed.');
    }
    await mongoose.disconnect().catch(() => {});
    throw error;
  }
}

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Received ${signal}; shutting down Hospital EMR API.`);

  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
    httpServer = undefined;
  }
  await mongoose.disconnect().catch(() => {
    console.error('MongoDB disconnect failed during shutdown.');
  });
}

if (require.main === module) {
  process.once('SIGINT', () => shutdown('SIGINT').catch(() => { process.exitCode = 1; }));
  process.once('SIGTERM', () => shutdown('SIGTERM').catch(() => { process.exitCode = 1; }));
  startServer().catch(() => { process.exitCode = 1; });
}

module.exports = { startServer, shutdown };
