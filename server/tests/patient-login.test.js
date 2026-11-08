'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');
const Patient = require('../models/Patient');

const patientId = '507f1f77bcf86cd799439011';
const userId = '507f1f77bcf86cd799439012';
let patientExists = true;
let patientAccountExists = true;
let active = true;
let phone = '+252 61 234 5678';
let passwordOk = true;
let tokenCount = 0;

Patient.findOne = (filter) => {
  assert.deepEqual(filter, { mrn: 'MRN-000007' });
  return { select: (fields) => {
    assert.equal(fields, '_id phone');
    return { lean: async () => patientExists ? { _id: patientId, phone } : null };
  } };
};
User.findOne = (filter) => {
  assert.deepEqual(filter, { role: 'patient', patient: patientId });
  if (!patientAccountExists) return { select: async () => null };
  return { select: async (fields) => {
    assert.equal(fields, '+password');
    return { _id: userId, patient: patientId, fullName: 'Patient Person', username: 'patient7', role: 'patient', isActive: active, password: 'stored-hash' };
  } };
};

const authPath = require.resolve('../services/auth.service');
const passwordPath = require.resolve('../utils/password');
const tokenPath = require.resolve('../utils/token');
const passwordModule = require('node:module');
const passwordStub = new passwordModule(passwordPath);
passwordStub.filename = passwordPath;
passwordStub.loaded = true;
passwordStub.exports = { comparePassword: async (value, hash) => value === 'correct-password' && hash === 'stored-hash' ? passwordOk : false };
require.cache[passwordPath] = passwordStub;
const tokenStub = new passwordModule(tokenPath);
tokenStub.filename = tokenPath;
tokenStub.loaded = true;
tokenStub.exports = { generateToken: (user) => { tokenCount += 1; assert.equal(user.role, 'patient'); return 'safe-test-token'; } };
require.cache[tokenPath] = tokenStub;
delete require.cache[authPath];
const { loginPatientUser } = require('../services/auth.service');

test.beforeEach(() => { patientExists = true; patientAccountExists = true; active = true; phone = '+252 61 234 5678'; passwordOk = true; tokenCount = 0; });

test('patient login normalizes MRN and phone and returns only a linked patient identity', async () => {
  const result = await loginPatientUser(' mrn-000007 ', '00252 (61) 234-5678', 'correct-password');
  assert.equal(result.token, 'safe-test-token');
  assert.equal(result.user.patient, patientId);
  assert.equal(result.user.role, 'patient');
  assert.equal(Object.hasOwn(result.user, 'password'), false);
});

test('patient login rejects a phone mismatch without issuing a token', async () => {
  await assert.rejects(loginPatientUser('MRN-000007', '252611111111', 'correct-password'), { status: 401 });
  assert.equal(tokenCount, 0);
});

test('patient login rejects inactive accounts, unlinked patients, and missing patient accounts', async () => {
  active = false;
  await assert.rejects(loginPatientUser('MRN-000007', '252612345678', 'correct-password'), { status: 401 });
  assert.equal(tokenCount, 0);
  active = true;
  patientExists = false;
  await assert.rejects(loginPatientUser('MRN-000007', '252612345678', 'correct-password'), { status: 401 });
  assert.equal(tokenCount, 0);
  patientExists = true;
  patientAccountExists = false;
  await assert.rejects(loginPatientUser('MRN-000007', '252612345678', 'correct-password'), { status: 401 });
  assert.equal(tokenCount, 0);
});

test('patient login rejects unsupported MRN and empty password', async () => {
  await assert.rejects(loginPatientUser('not-an-mrn', '252612345678', 'correct-password'), { status: 400 });
  await assert.rejects(loginPatientUser('MRN-000007', '252612345678', '   '), { status: 400 });
  assert.equal(tokenCount, 0);
});
