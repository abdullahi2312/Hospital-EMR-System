'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sendSms } = require('../adapters/sms.adapter');

const validInput = {
  phoneNumber: '+252612345678',
  message: 'Your appointment reminder is ready.',
  idempotencyKey: `sms-test-${process.pid}`
};

test('returns a simulated success with server timestamp and safe metadata', async () => {
  const before = Date.now();
  const result = await sendSms(validInput);
  assert.equal(result.simulated, true);
  assert.equal(result.provider, 'simulated');
  assert.equal(result.deliveryStatus, 'simulated_success');
  assert.match(result.providerReference, /^sim-sms-/);
  assert.ok(result.createdAt instanceof Date);
  assert.ok(result.createdAt.getTime() >= before);
  assert.equal(result.metadata.messageCharacters, validInput.message.length);
  assert.equal(JSON.stringify(result).includes(validInput.phoneNumber), false);
  assert.equal(JSON.stringify(result).includes(validInput.message), false);
});

test('rejects invalid phone numbers and invalid or oversized messages', async () => {
  await assert.rejects(sendSms({ ...validInput, phoneNumber: '0612345678' }), /E\.164/);
  await assert.rejects(sendSms({ ...validInput, message: '   ' }), /message must contain/);
  await assert.rejects(sendSms({ ...validInput, message: 'x'.repeat(501) }), /message must contain/);
  await assert.rejects(sendSms({ ...validInput, extra: 'not allowed' }), /unsupported fields/);
});

test('returns a structured simulated provider failure without throwing', async () => {
  const result = await sendSms({
    ...validInput,
    idempotencyKey: `sms-fail-${process.pid}`,
    simulateOutcome: 'failure'
  });
  assert.equal(result.simulated, true);
  assert.equal(result.deliveryStatus, 'simulated_failure');
  assert.equal(result.error.code, 'SIMULATED_PROVIDER_FAILURE');
  assert.equal(result.error.message, 'Simulated SMS provider failure');
});

test('same idempotency key replays one simulated result and rejects different input', async () => {
  const key = `sms-retry-${process.pid}`;
  const first = await sendSms({ ...validInput, idempotencyKey: key });
  const retry = await sendSms({ ...validInput, idempotencyKey: key });
  assert.equal(retry.providerReference, first.providerReference);
  assert.equal(retry.createdAt.getTime(), first.createdAt.getTime());
  assert.equal(retry.metadata.replayed, true);

  const conflict = await sendSms({ ...validInput, idempotencyKey: key, message: 'Changed content' });
  assert.equal(conflict.deliveryStatus, 'simulated_failure');
  assert.equal(conflict.error.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('does not log phone numbers or message content and performs no network calls', async () => {
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalFetch = global.fetch;
  let logCalls = 0;
  let fetchCalls = 0;
  console.log = console.info = console.warn = console.error = () => { logCalls += 1; };
  global.fetch = async () => { fetchCalls += 1; throw new Error('Unexpected network call'); };
  try {
    await sendSms({ ...validInput, idempotencyKey: `sms-no-net-${process.pid}` });
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
    global.fetch = originalFetch;
  }
  assert.equal(logCalls, 0);
  assert.equal(fetchCalls, 0);
});
