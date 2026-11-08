'use strict';

const mongoose = require('mongoose');
const User = require('../models/User');
const { createUser } = require('../services/user.service');

const BOOTSTRAP_ENV_KEY = 'HOSPITAL_EMR_BOOTSTRAP_ENV';
const BOOTSTRAP_URI_KEY = 'HOSPITAL_EMR_BOOTSTRAP_MONGO_URI';
const BOOTSTRAP_EMAIL_KEY = 'HOSPITAL_EMR_BOOTSTRAP_EMAIL';
const BOOTSTRAP_PASSWORD_KEY = 'HOSPITAL_EMR_BOOTSTRAP_PASSWORD';
const PRODUCTION_MARKER = /prod(?:uction)?|live/i;

function bootstrapError(message) {
  const error = new Error(message);
  error.name = 'AdminBootstrapError';
  return error;
}

function normalizeEmailAsUsername(email) {
  if (typeof email !== 'string') throw bootstrapError('A valid admin email is required');
  const username = email.trim().toLowerCase();
  if (username.length < 3 || username.length > 30 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) {
    throw bootstrapError('Admin email must be a valid email address no longer than 30 characters');
  }
  return username;
}

function displayNameFromEmail(username) {
  const localPart = username.slice(0, username.indexOf('@'));
  const words = localPart.replace(/[._+-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const name = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  return name.length >= 2 && name.length <= 100 ? name : 'System Administrator';
}

function validateBootstrapEnvironment(environment = process.env) {
  const mode = environment[BOOTSTRAP_ENV_KEY];
  if (typeof mode !== 'string' || mode.trim().toLowerCase() !== 'development' || PRODUCTION_MARKER.test(mode)) {
    throw bootstrapError(`${BOOTSTRAP_ENV_KEY} must be explicitly set to development`);
  }

  for (const key of [
    'NODE_ENV', 'APP_ENV', 'ENVIRONMENT', 'DEPLOYMENT_ENV', 'VERCEL_ENV', 'RAILWAY_ENVIRONMENT'
  ]) {
    if (PRODUCTION_MARKER.test(String(environment[key] || ''))) {
      throw bootstrapError('Admin bootstrap is disabled in production or live environments');
    }
  }

  const uri = environment[BOOTSTRAP_URI_KEY];
  if (typeof uri !== 'string' || !uri.trim()) throw bootstrapError(`${BOOTSTRAP_URI_KEY} is required`);

  let parsed;
  try {
    parsed = new URL(uri);
  } catch (_) {
    throw bootstrapError(`${BOOTSTRAP_URI_KEY} must be a valid MongoDB URI`);
  }
  if (parsed.protocol !== 'mongodb:' || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw bootstrapError('Admin bootstrap only permits a local mongodb:// host');
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] || '');
  if (!databaseName || PRODUCTION_MARKER.test(databaseName) || !/^[a-z0-9_-]+$/i.test(databaseName)) {
    throw bootstrapError('MongoDB database name is missing or indicates production');
  }

  const username = normalizeEmailAsUsername(environment[BOOTSTRAP_EMAIL_KEY]);
  const password = environment[BOOTSTRAP_PASSWORD_KEY];
  if (typeof password !== 'string' || password.trim().length === 0) {
    throw bootstrapError(`${BOOTSTRAP_PASSWORD_KEY} must be supplied at runtime`);
  }
  if (Buffer.byteLength(password, 'utf8') > 72 || /^\$2[aby]\$\d{2}\$/.test(password)) {
    throw bootstrapError('Admin password must be plaintext and no more than 72 UTF-8 bytes');
  }

  return { uri, databaseName, username, fullName: displayNameFromEmail(username), password };
}

async function createBootstrapAdmin({ environment = process.env, userModel = User, createUserImpl = createUser } = {}) {
  const config = validateBootstrapEnvironment(environment);
  const existing = await userModel.findOne({ username: config.username });
  if (existing) return { created: false, id: String(existing._id), username: config.username };

  try {
    const user = await createUserImpl({
      username: config.username,
      fullName: config.fullName,
      password: config.password,
      role: 'admin',
      isActive: true
    });
    return { created: true, id: String(user._id || user.id), username: config.username };
  } catch (error) {
    // A concurrent bootstrap may win the unique username index after the read.
    if (error?.status === 409 || error?.code === 11000) {
      const duplicate = await userModel.findOne({ username: config.username });
      if (duplicate) return { created: false, id: String(duplicate._id), username: config.username };
    }
    throw error;
  }
}

async function assertDatabaseExists(connection, databaseName) {
  let databases;
  try {
    databases = await connection.db.admin().listDatabases({ nameOnly: true });
  } catch (_) {
    throw bootstrapError('Unable to confirm the target database exists; no account was created');
  }
  if (!databases.databases?.some((database) => database.name === databaseName)) {
    throw bootstrapError('The confirmed development database does not exist; no database or account was created');
  }
}

async function runFromEnvironment() {
  const config = validateBootstrapEnvironment();
  await mongoose.connect(config.uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await assertDatabaseExists(mongoose.connection, config.databaseName);
    return await createBootstrapAdmin();
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  runFromEnvironment()
    .then((result) => {
      process.stdout.write(result.created
        ? `Admin account created. Login username: ${result.username}\n`
        : 'An account with that username already exists; no account fields were changed.\n');
    })
    .catch((error) => {
      const safeMessage = error?.name === 'AdminBootstrapError' || error?.name === 'UserServiceError'
        ? error.message
        : 'Database operation failed. No connection details or credentials are displayed.';
      process.stderr.write(`Admin bootstrap failed: ${safeMessage}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  createBootstrapAdmin,
  normalizeEmailAsUsername,
  validateBootstrapEnvironment,
  assertDatabaseExists
};
