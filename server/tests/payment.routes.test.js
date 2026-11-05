'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const mongoose = require('mongoose');

process.env.JWT_SECRET = 'payment-routes-test-secret-with-sufficient-entropy-123';
process.env.JWT_EXPIRES_IN = '1d';

const User = require('../models/User');
const { generateToken } = require('../utils/token');

const patientId = new mongoose.Types.ObjectId();
const doctorId = new mongoose.Types.ObjectId();
const patientRecordId = new mongoose.Types.ObjectId();
const serviceCalls = [];
const accounts = new Map([
  [String(patientId), { _id: patientId, fullName: 'Test Patient', username: 'test-patient', role: 'patient', patient: patientRecordId, isActive: true }],
  [String(doctorId), { _id: doctorId, fullName: 'Test Doctor', username: 'test-doctor', role: 'doctor', isActive: true }]
]);

function serviceError(message, status, extra = {}) {
  return Object.assign(new Error(message), { name: 'PaymentServiceError', status, statusCode: status, ...extra });
}

const paymentServiceMock = {
  async initiatePatientPayment(input, user) {
    serviceCalls.push({ method: 'initiate', input, user });
    if (input.idempotencyKey === 'conflict-key-0001') throw serviceError('Idempotency conflict', 409);
    if (input.idempotencyKey === 'partial-key-0001') {
      throw serviceError('internal sensitive details', 503, { partialSuccess: true, paymentReference: 'pay-12345678-1234-4234-8234-123456789012' });
    }
    if (input.idempotencyKey === 'validation-key-01') throw serviceError('Amount is invalid', 400);
    if (input.idempotencyKey === 'server-error-key') throw serviceError('internal database details', 500);
    return {
      id: 'payment-id',
      paymentReference: 'pay-12345678-1234-4234-8234-123456789012',
      patient: String(patientRecordId),
      amount: input.amount,
      currency: input.currency,
      status: 'simulated_success',
      provider: 'simulated-mobile-money',
      simulated: true,
      message: 'This is a payment simulation; no real money was transferred.',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      phoneNumber: input.phoneNumber,
      description: input.description,
      idempotencyKey: input.idempotencyKey,
      initiatingUser: String(patientId),
      inputFingerprint: 'private-fingerprint',
      auditMetadata: { actor: String(patientId) },
      otp: '123456'
    };
  },
  async listPatientPayments(options, user) {
    serviceCalls.push({ method: 'list', options, user });
    return {
      payments: [{
        paymentReference: 'pay-12345678-1234-4234-8234-123456789012',
        patient: String(patientRecordId), amount: 5, currency: 'USD', status: 'pending',
        phoneNumber: '+252612345678', description: 'private', inputFingerprint: 'private',
        idempotencyKey: 'private', auditMetadata: { secret: true }
      }],
      pagination: { page: Number(options.page || 1), limit: Number(options.limit || 20), hasMore: false }
    };
  },
  async getPatientPaymentStatus(paymentReference, user) {
    serviceCalls.push({ method: 'status', paymentReference, user });
    if (paymentReference === 'pay-12345678-1234-4234-8234-123456789013') {
      throw serviceError('Payment not found', 404);
    }
    if (paymentReference === 'bad-reference') throw serviceError('A valid payment reference is required', 400);
    return {
      paymentReference,
      patient: String(patientRecordId),
      amount: 15,
      currency: 'SOS',
      status: 'pending',
      provider: 'simulated-mobile-money',
      simulated: true,
      message: 'No real money was transferred.',
      phoneNumber: '+252612345678', description: 'private', inputFingerprint: 'private',
      idempotencyKey: 'private', auditMetadata: { secret: true }, otp: '123456'
    };
  }
};

const servicePath = require.resolve('../services/payment.service');
const serviceModule = new Module(servicePath);
serviceModule.filename = servicePath;
serviceModule.loaded = true;
serviceModule.exports = paymentServiceMock;
require.cache[servicePath] = serviceModule;

User.findById = (id) => ({
  select() { return this; },
  lean: async () => accounts.get(String(id)) || null
});

const app = require('../app');
const paymentRouter = require('../routes/payment.routes');
const server = http.createServer(app);

function token(id, role) {
  return generateToken({ id: String(id), role });
}

function request(port, method, path, authToken, body) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
        ...(encoded ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) } : {})
      }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    if (encoded) req.write(encoded);
    req.end();
  });
}

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});
test.beforeEach(() => { serviceCalls.length = 0; });

test('patient can initiate, list, and retrieve payment status using standard response envelopes', async () => {
  const port = server.address().port;
  const patientToken = token(patientId, 'patient');
  let result = await request(port, 'POST', '/api/payments', patientToken, {
    phoneNumber: '+252612345678', amount: 12, currency: 'USD', description: 'private description', idempotencyKey: 'pay-key-0001'
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.match(result.body.message, /simulated payment.*No real money/i);
  assert.equal(serviceCalls[0].method, 'initiate');
  assert.deepEqual(serviceCalls[0].user, { id: String(patientId), fullName: 'Test Patient', username: 'test-patient', role: 'patient', patient: String(patientRecordId) });
  assert.deepEqual(serviceCalls[0].input, {
    phoneNumber: '+252612345678', amount: 12, currency: 'USD', description: 'private description', idempotencyKey: 'pay-key-0001'
  });
  assert.equal(JSON.stringify(result.body).includes('private description'), false);
  assert.equal(JSON.stringify(result.body).includes(String(patientRecordId)), false);
  assert.equal(JSON.stringify(result.body).includes('+252612345678'), false);
  assert.equal(JSON.stringify(result.body).includes('private-fingerprint'), false);
  assert.equal(JSON.stringify(result.body).includes('idempotencyKey'), false);
  assert.equal(JSON.stringify(result.body).includes('otp'), false);

  result = await request(port, 'GET', '/api/payments?page=2&limit=10', patientToken);
  assert.equal(result.status, 200);
  assert.equal(serviceCalls[1].method, 'list');
  assert.deepEqual(serviceCalls[1].options, { page: '2', limit: '10' });
  assert.equal(JSON.stringify(result.body).includes('+252612345678'), false);
  assert.equal(JSON.stringify(result.body).includes('private'), false);

  result = await request(port, 'GET', '/api/payments/pay-12345678-1234-4234-8234-123456789012/status', patientToken);
  assert.equal(result.status, 200);
  assert.equal(serviceCalls[2].method, 'status');
  assert.equal(serviceCalls[2].paymentReference, 'pay-12345678-1234-4234-8234-123456789012');
  for (const secretField of ['inputFingerprint', 'idempotencyKey', 'description', 'phoneNumber', 'credentials']) {
    assert.equal(JSON.stringify(result.body).includes(secretField), false);
  }
  assert.equal(JSON.stringify(result.body).includes(String(patientRecordId)), false);
});

test('missing and invalid tokens are rejected by the existing authentication middleware', async () => {
  const port = server.address().port;
  let result = await request(port, 'GET', '/api/payments');
  assert.equal(result.status, 401);
  result = await request(port, 'GET', '/api/payments', 'not-a-valid-jwt');
  assert.equal(result.status, 401);
});

test('non-patient database roles are rejected on all payment endpoints', async () => {
  const port = server.address().port;
  const doctorToken = token(doctorId, 'doctor');
  for (const [method, path, body] of [
    ['POST', '/api/payments', { phoneNumber: '+252612345678', amount: 5, currency: 'USD', idempotencyKey: 'role-test-0001' }],
    ['GET', '/api/payments'],
    ['GET', '/api/payments/pay-12345678-1234-4234-8234-123456789012/status']
  ]) {
    const result = await request(port, method, path, doctorToken, body);
    assert.equal(result.status, 403);
  }
  assert.equal(serviceCalls.length, 0);
});

test('strict request allowlists reject spoofed identity and server-managed fields', async () => {
  const port = server.address().port;
  const patientToken = token(patientId, 'patient');
  const valid = { phoneNumber: '+252612345678', amount: 5, currency: 'USD', idempotencyKey: 'allowlist-test' };
  for (const field of ['patientId', 'patient', 'initiatingUser', 'actorId', 'status', 'provider', 'inputFingerprint', 'paymentReference', 'createdAt', 'updatedAt', 'pin', 'otp']) {
    const result = await request(port, 'POST', '/api/payments', patientToken, { ...valid, [field]: 'spoofed' });
    assert.equal(result.status, 400, field);
  }
  let result = await request(port, 'GET', '/api/payments?patientId=someone', patientToken);
  assert.equal(result.status, 400);
  result = await request(port, 'GET', '/api/payments?page=1&unknown=x', patientToken);
  assert.equal(result.status, 400);
  result = await request(port, 'GET', '/api/payments/pay-12345678-1234-4234-8234-123456789012/status?patientId=someone', patientToken);
  assert.equal(result.status, 400);
  result = await request(port, 'POST', '/api/payments?status=simulated_success', patientToken, valid);
  assert.equal(result.status, 400);
  assert.equal(serviceCalls.length, 0);
});

test('service validation, conflict, not-found, and server errors map safely', async () => {
  const port = server.address().port;
  const patientToken = token(patientId, 'patient');
  const base = { phoneNumber: '+252612345678', amount: 5, currency: 'USD' };
  let result = await request(port, 'POST', '/api/payments', patientToken, { ...base, idempotencyKey: 'validation-key-01' });
  assert.equal(result.status, 400);
  result = await request(port, 'POST', '/api/payments', patientToken, { ...base, idempotencyKey: 'conflict-key-0001' });
  assert.equal(result.status, 409);
  result = await request(port, 'GET', '/api/payments/pay-12345678-1234-4234-8234-123456789013/status', patientToken);
  assert.equal(result.status, 404);
  assert.equal(result.body.message, 'Payment not found');
  result = await request(port, 'POST', '/api/payments', patientToken, { ...base, idempotencyKey: 'server-error-key' });
  assert.equal(result.status, 500);
  assert.equal(result.body.message, 'Unable to process payment request');
  assert.equal(JSON.stringify(result.body).includes('internal database details'), false);
});

test('partial-success response is explicit and does not expose service internals', async () => {
  const port = server.address().port;
  const result = await request(port, 'POST', '/api/payments', token(patientId, 'patient'), {
    phoneNumber: '+252612345678', amount: 5, currency: 'USD', idempotencyKey: 'partial-key-0001'
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.success, false);
  assert.equal(result.body.data.partialSuccess, true);
  assert.match(result.body.message, /may already be recorded.*same idempotency key/i);
  assert.equal(JSON.stringify(result.body).includes('internal sensitive details'), false);
});

test('router is mounted once with authenticate then patient authorization on every route; health remains available', async () => {
  const routeLayers = paymentRouter.stack.filter((layer) => layer.route);
  assert.deepEqual(routeLayers.map((layer) => [layer.route.path, Object.keys(layer.route.methods)[0]]), [
    ['/', 'post'], ['/', 'get'], ['/:paymentReference/status', 'get']
  ]);
  const controllers = ['initiate', 'list', 'getStatus'];
  routeLayers.forEach((layer, index) => {
    assert.deepEqual(layer.route.stack.map((handler) => handler.name), [
      'authenticate', 'authorizeRequest', controllers[index]
    ]);
  });
  const mountCount = app.router.stack.filter((layer) => layer.name === 'router' && layer.handle === paymentRouter).length;
  assert.equal(mountCount, 1);

  const result = await request(server.address().port, 'GET', '/api/health');
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
});
