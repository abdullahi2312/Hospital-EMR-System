'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initiatePayment, getPaymentStatus } = require('../adapters/mobile-money.adapter');

function paymentInput(overrides = {}) {
  return {
    phoneNumber: '+252612345678',
    amount: 24.5,
    currency: 'USD',
    description: 'Invoice payment',
    idempotencyKey: `money-test-${process.pid}`,
    ...overrides
  };
}

test('initiates a simulated payment and looks up its status', async () => {
  const before = Date.now();
  const payment = await initiatePayment(paymentInput());
  assert.equal(payment.simulated, true);
  assert.equal(payment.provider, 'simulated-mobile-money');
  assert.equal(payment.status, 'simulated_success');
  assert.match(payment.paymentReference, /^sim-mm-/);
  assert.equal(payment.amount, 24.5);
  assert.equal(payment.currency, 'USD');
  assert.ok(payment.createdAt instanceof Date);
  assert.ok(payment.createdAt.getTime() >= before);
  assert.equal(JSON.stringify(payment).includes('+252612345678'), false);
  assert.equal(JSON.stringify(payment).includes('Invoice payment'), false);
  assert.deepEqual(await getPaymentStatus(payment.paymentReference), payment);
  assert.equal(await getPaymentStatus('sim-mm-not-known'), null);
});

test('rejects invalid phone numbers, amount values, currencies, and descriptions', async () => {
  await assert.rejects(initiatePayment(paymentInput({ phoneNumber: '0612345678' })), /E\.164/);
  for (const amount of [0, -1, NaN, Infinity, -Infinity, 1_000_000.01, '10']) {
    await assert.rejects(initiatePayment(paymentInput({ amount })), /Amount must be/);
  }
  await assert.rejects(initiatePayment(paymentInput({ amount: 1.001 })), /two decimal places/);
  await assert.rejects(initiatePayment(paymentInput({ currency: 'EUR' })), /supported currencies/);
  await assert.rejects(initiatePayment(paymentInput({ description: 'x'.repeat(141) })), /Description cannot exceed/);
  await assert.rejects(initiatePayment(paymentInput({ status: 'success' })), /unsupported or server-managed/);
});

test('supports simulated success, pending, and failure results', async () => {
  for (const outcome of ['success', 'pending', 'failure']) {
    const payment = await initiatePayment(paymentInput({
      idempotencyKey: `outcome-${outcome}-${process.pid}`,
      simulateOutcome: outcome
    }));
    assert.equal(payment.status, `simulated_${outcome}`);
    if (outcome === 'failure') {
      assert.equal(payment.error.code, 'SIMULATED_PAYMENT_FAILURE');
      assert.equal(payment.error.message, 'Simulated mobile money provider failure');
    }
  }
  await assert.rejects(initiatePayment(paymentInput({ simulateOutcome: 'unknown' })), /Simulated outcome/);
});

test('same idempotency key returns the original payment; changed input conflicts', async () => {
  const key = `retry-payment-${process.pid}`;
  const first = await initiatePayment(paymentInput({ idempotencyKey: key }));
  const retry = await initiatePayment(paymentInput({ idempotencyKey: key }));
  assert.equal(retry.paymentReference, first.paymentReference);
  assert.equal(retry.createdAt.getTime(), first.createdAt.getTime());
  assert.deepEqual(retry, first);
  await assert.rejects(
    initiatePayment(paymentInput({ idempotencyKey: key, amount: 30 })),
    (error) => error.code === 'IDEMPOTENCY_KEY_CONFLICT' && error.status === 409
  );
});

test('does not log sensitive inputs or call external networks', async () => {
  const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const originalFetch = global.fetch;
  let logs = 0;
  let networkCalls = 0;
  console.log = console.info = console.warn = console.error = () => { logs += 1; };
  global.fetch = async () => { networkCalls += 1; throw new Error('Unexpected network call'); };
  try {
    await initiatePayment(paymentInput({ idempotencyKey: `safe-log-${process.pid}` }));
  } finally {
    Object.assign(console, originalConsole);
    global.fetch = originalFetch;
  }
  assert.equal(logs, 0);
  assert.equal(networkCalls, 0);
});
