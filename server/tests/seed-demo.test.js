'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDemoEnvironment } = require('../scripts/seed-demo');

const keys = ['MONGO_DEMO_URI', 'DEMO_SEED_PASSWORD', 'PATIENT_IDENTITY_HMAC_SECRET'];

function withDemoEnv(values, callback) {
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return callback();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('demo seed accepts only local demo databases and valid local-only secrets', () => {
  const valid = {
    MONGO_DEMO_URI: 'mongodb://127.0.0.1:27017/hospital_emr_demo_test',
    DEMO_SEED_PASSWORD: 'local-only-demo-password',
    PATIENT_IDENTITY_HMAC_SECRET: 'x'.repeat(40)
  };
  withDemoEnv(valid, () => assert.equal(validateDemoEnvironment().uri, valid.MONGO_DEMO_URI));
  for (const uri of [
    'mongodb://127.0.0.1:27017/hospital_emr',
    'mongodb://example.com:27017/hospital_emr_demo_test',
    'mongodb://127.0.0.1:27017/hospital_emr_demo_prod'
  ]) {
    withDemoEnv({ ...valid, MONGO_DEMO_URI: uri }, () => assert.throws(validateDemoEnvironment, /Demo seeding/));
  }
  withDemoEnv({ ...valid, DEMO_SEED_PASSWORD: 'short' }, () => assert.throws(validateDemoEnvironment, /DEMO_SEED_PASSWORD/));
  withDemoEnv({ ...valid, PATIENT_IDENTITY_HMAC_SECRET: 'short' }, () => assert.throws(validateDemoEnvironment, /PATIENT_IDENTITY_HMAC_SECRET/));
});
