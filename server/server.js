require('dotenv').config();

const app = require('./app');
const connectDB = require('./config/db');
const { expireBreakGlassAuthorizations } = require('./services/break-glass-expiration.service');
const port = Number(process.env.PORT) || 5000;

async function startServer() {
  try {
    await connectDB();

    let expirationResult;
    try {
      expirationResult = await expireBreakGlassAuthorizations();
    } catch (_) {
      console.error('Server startup aborted: initial BreakGlass expiration failed.');
      process.exit(1);
      return;
    }

    console.log(`Initial BreakGlass expiration completed; records expired: ${expirationResult.expiredCount}`);
    app.listen(port, () => {
      console.log(`Hospital EMR API listening on port ${port}`);
    });
  } catch (error) {
    console.error(`Server startup aborted: ${error.message}`);
    process.exit(1);
  }
}

startServer();
