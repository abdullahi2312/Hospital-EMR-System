require('dotenv').config();

const app = require('./app');
const connectDB = require('./config/db');
const port = Number(process.env.PORT) || 5000;

async function startServer() {
  try {
    await connectDB();
    app.listen(port, () => {
      console.log(`Hospital EMR API listening on port ${port}`);
    });
  } catch (error) {
    console.error(`Server startup aborted: ${error.message}`);
    process.exit(1);
  }
}

startServer();
