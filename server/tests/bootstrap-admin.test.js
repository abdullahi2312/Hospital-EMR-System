'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const User = require('../models/User');
const { comparePassword, hashPassword } = require('../utils/password');
const { createBootstrapAdmin, validateBootstrapEnvironment } = require('../scripts/bootstrap-admin');

const keys = [User, User.findOne, User.prototype.save];
let accounts;

function environment(overrides = {}) {
  return {
    HOSPITAL_EMR_BOOTSTRAP_ENV: 'development',
    HOSPITAL_EMR_BOOTSTRAP_MONGO_URI: 'mongodb://127.0.0.1:27017/hospital_emr_dev_test',
    HOSPITAL_EMR_BOOTSTRAP_EMAIL: '  Abdalla@Gmail.com ',
    HOSPITAL_EMR_BOOTSTRAP_PASSWORD: crypto.randomBytes(24).toString('base64url'),
    ...overrides
  };
}

function installMemoryUserStore() {
  accounts = new Map();
  User.findOne = async ({ username }) => accounts.get(username) || null;
  User.prototype.save = async function saveInMemory() {
    if (accounts.has(this.username)) {
      const error = new Error('duplicate username');
      error.code = 11000;
      error.keyPattern = { username: 1 };
      throw error;
    }
    accounts.set(this.username, this);
    return this;
  };
}

test('bootstrap creates an active admin with normalized email and the standard password hash', async (t) => {
  installMemoryUserStore();
  t.after(() => { User.findOne = keys[1]; User.prototype.save = keys[2]; });

  const config = environment();
  const result = await createBootstrapAdmin({ environment: config });
  const user = accounts.get('abdalla@gmail.com');

  assert.equal(result.created, true);
  assert.equal(result.username, 'abdalla@gmail.com');
  assert.equal(user.fullName, 'Abdalla');
  assert.equal(user.role, 'admin');
  assert.equal(user.isActive, true);
  assert.notEqual(user.password, config.HOSPITAL_EMR_BOOTSTRAP_PASSWORD);
  assert.match(user.password, /^\$2[aby]\$12\$/);
  assert.equal(await comparePassword(config.HOSPITAL_EMR_BOOTSTRAP_PASSWORD, user.password), true);
});

test('rerunning bootstrap on an existing email does not change password, role, or active state', async (t) => {
  installMemoryUserStore();
  t.after(() => { User.findOne = keys[1]; User.prototype.save = keys[2]; });
  const existingStoredHash = await hashPassword(crypto.randomBytes(24).toString('base64url'));
  const existing = new User({
    fullName: 'Existing account', username: 'abdalla@gmail.com', password: existingStoredHash, role: 'doctor', isActive: false
  });
  accounts.set(existing.username, existing);
  const before = existing.toObject();
  let createCalls = 0;

  const result = await createBootstrapAdmin({
    environment: environment(),
    createUserImpl: async () => { createCalls += 1; throw new Error('must not create'); }
  });

  assert.equal(result.created, false);
  assert.equal(createCalls, 0);
  assert.deepEqual(existing.toObject(), before);
});

test('bootstrap refuses production environment and production-named databases before account lookup', async () => {
  const productionEnvironment = environment({ NODE_ENV: 'production' });
  assert.throws(() => validateBootstrapEnvironment(productionEnvironment), /disabled in production/);

  const productionDatabase = environment({
    HOSPITAL_EMR_BOOTSTRAP_MONGO_URI: 'mongodb://127.0.0.1:27017/hospital_emr_prod'
  });
  assert.throws(() => validateBootstrapEnvironment(productionDatabase), /database name.*production/i);

  let lookupCalled = false;
  await assert.rejects(createBootstrapAdmin({
    environment: productionEnvironment,
    userModel: { findOne: async () => { lookupCalled = true; return null; } }
  }), /disabled in production/);
  assert.equal(lookupCalled, false);
});

test('bootstrap refuses remote MongoDB hosts even when the environment says development', () => {
  const remote = environment({
    HOSPITAL_EMR_BOOTSTRAP_MONGO_URI: 'mongodb://db.example.invalid:27017/hospital_emr_dev'
  });
  assert.throws(() => validateBootstrapEnvironment(remote), /only permits a local/);
});
