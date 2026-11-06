'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const { ensureIndexes } = require('../config/ensure-indexes');

async function main() {
  try {
    await connectDB();
    const result = await ensureIndexes();
    console.log(`MongoDB indexes ready for ${result.modelCount} models`);
  } catch (error) {
    if (error?.name === 'IndexReadinessError') {
      console.error(`Index deployment failed for model ${error.modelName}; inspect existing data and index definitions.`);
    } else {
      console.error('Index deployment failed; verify MongoDB connectivity and configuration.');
    }
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

main();
