'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const User = require('../models/User');

const authUser = { _id: '507f1f77bcf86cd799439011', username: 'account', password: 'stored-hash', fullName: 'Test Account', role: 'doctor' };
let databaseActiveValue;
let findOneCalls = 0;
let findByIdCalls = 0;
let tokenCalls = 0;

User.findOne = (filter) => {
  findOneCalls += 1;
  assert.deepEqual(filter, { username: 'account' });
  return { select: async (selection) => {
    assert.equal(selection, '+password');
    return { ...authUser, ...(databaseActiveValue !== OMITTED ? { isActive: databaseActiveValue } : {}) };
  } };
};
User.findById = (id) => {
  findByIdCalls += 1;
  assert.equal(id, authUser._id);
  return {
    select(selection) {
      assert.equal(selection, '_id fullName username role patient isActive');
      return this;
    },
    lean: async () => ({
      _id: authUser._id,
      fullName: authUser.fullName,
      username: authUser.username,
      role: 'admin', // Current database role must win over any JWT role claim.
      isActive: databaseActiveValue
    })
  };
};

const OMITTED = Symbol('omitted');
const tokenPath = require.resolve('../utils/token');
const tokenModule = new Module(tokenPath);
tokenModule.filename = tokenPath;
tokenModule.loaded = true;
tokenModule.exports = {
  generateToken(user) {
    tokenCalls += 1;
    assert.equal(user._id, authUser._id);
    return 'test-token';
  },
  verifyToken(token) {
    assert.equal(token, 'test-token');
    return { sub: authUser._id, role: 'patient' };
  }
};
require.cache[tokenPath] = tokenModule;

const passwordPath = require.resolve('../utils/password');
const passwordModule = new Module(passwordPath);
passwordModule.filename = passwordPath;
passwordModule.loaded = true;
passwordModule.exports = { comparePassword: async (password, hash) => password === 'correct-password' && hash === 'stored-hash' };
require.cache[passwordPath] = passwordModule;

const { loginUser } = require('../services/auth.service');
const { authenticate } = require('../middleware/auth.middleware');

const activeValues = [
  { label: 'false', value: false },
  { label: 'missing', value: OMITTED },
  { label: 'null', value: null },
  { label: 'invalid string', value: 'true' },
  { label: 'invalid number', value: 1 }
];

test.beforeEach(() => {
  databaseActiveValue = true;
  findOneCalls = 0;
  findByIdCalls = 0;
  tokenCalls = 0;
});

test('login accepts only a current database user with isActive exactly true', async () => {
  const result = await loginUser('account', 'correct-password');
  assert.equal(result.token, 'test-token');
  assert.equal(result.user.role, 'doctor');
  assert.equal(findOneCalls, 1);
  assert.equal(tokenCalls, 1);
});

for (const item of activeValues) {
  test(`login rejects isActive ${item.label} with the generic credentials error`, async () => {
    databaseActiveValue = item.value;
    await assert.rejects(loginUser('account', 'correct-password'), (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.message, 'Invalid username or password');
      return true;
    });
    assert.equal(tokenCalls, 0);
  });
}

function invokeAuthenticate() {
  const req = { get: () => 'Bearer test-token' };
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  let nextCalls = 0;
  let nextError;
  return authenticate(req, res, (error) => { nextCalls += 1; nextError = error; })
    .then(() => ({ req, res, nextCalls, nextError }));
}

test('authentication accepts an active database user and uses its current role', async () => {
  const result = await invokeAuthenticate();
  assert.equal(findByIdCalls, 1);
  assert.equal(result.nextCalls, 1);
  assert.equal(result.nextError, undefined);
  assert.equal(result.req.user.role, 'admin');
  assert.equal(Object.hasOwn(result.req.user, 'password'), false);
});

for (const item of activeValues) {
  test(`authentication rejects isActive ${item.label} with HTTP 401`, async () => {
    databaseActiveValue = item.value;
    const result = await invokeAuthenticate();
    assert.equal(findByIdCalls, 1);
    assert.equal(result.nextCalls, 0);
    assert.equal(result.res.statusCode, 401);
    assert.deepEqual(result.res.body, { success: false, message: 'Authentication required', data: null });
  });
}
