'use strict';

const path = require('node:path');
const dotenv = require('dotenv');

const projectRoot = path.resolve(__dirname, '../..');

// Resolve environment files from the project root so startup works the same
// whether npm is invoked from the repository root or the server directory.
dotenv.config({ path: path.join(projectRoot, '.env') });
dotenv.config({ path: path.join(projectRoot, '.env.local') });

