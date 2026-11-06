'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureIndexes, MODEL_FILES } = require('../config/ensure-indexes');

test('index readiness covers every registered application model without synchronization', async () => {
  const calls = [];
  const models = MODEL_FILES.map((modelName) => ({
    modelName,
    async createIndexes() { calls.push(modelName); }
  }));

  const result = await ensureIndexes(models);
  assert.deepEqual(result, { modelCount: MODEL_FILES.length });
  assert.deepEqual(calls, MODEL_FILES);
});

test('index readiness fails clearly and identifies the model when index creation fails', async () => {
  const models = [
    { modelName: 'ReadyModel', async createIndexes() {} },
    { modelName: 'DuplicateDataModel', async createIndexes() { throw new Error('private database details'); } }
  ];

  await assert.rejects(ensureIndexes(models), (error) => {
    assert.equal(error.name, 'IndexReadinessError');
    assert.equal(error.modelName, 'DuplicateDataModel');
    assert.match(error.message, /DuplicateDataModel/);
    assert.doesNotMatch(error.message, /private database details/);
    return true;
  });
});
