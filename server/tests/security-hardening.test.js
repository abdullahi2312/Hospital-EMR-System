'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { createLoginRateLimiter } = require('../middleware/login-rate-limit.middleware');
const securityHeaders = require('../middleware/security-headers.middleware');
const notFound = require('../middleware/not-found');
const errorHandler = require('../middleware/error-handler');
const authRouter = require('../routes/auth.routes');

test('login limiter bounds attempts per socket address, ignores forwarded identity, and resets after its window', () => {
  let now = 1000;
  const limiter = createLoginRateLimiter({ windowMs: 1000, maxAttempts: 2, now: () => now });
  let passed = 0;
  function call(address, forwardedFor) {
    const res = {
      statusCode: 200,
      headers: {},
      set(name, value) { this.headers[name] = value; return this; },
      status(status) { this.statusCode = status; return this; },
      json(body) { this.body = body; return this; }
    };
    limiter({ socket: { remoteAddress: address }, headers: { 'x-forwarded-for': forwardedFor } }, res, () => { passed += 1; });
    return res;
  }

  call('192.0.2.1', '198.51.100.1');
  call('192.0.2.1', '198.51.100.2');
  const limited = call('192.0.2.1', '203.0.113.9');
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers['Retry-After'], '1');
  assert.deepEqual(limited.body, { success: false, message: 'Too many login attempts. Try again later.', data: null });
  assert.equal(passed, 2);
  call('192.0.2.2', '198.51.100.1');
  assert.equal(passed, 3);
  now += 1000;
  call('192.0.2.1', '198.51.100.1');
  assert.equal(passed, 4);
});

test('login route applies the rate limiter before the authentication controller', () => {
  const route = authRouter.stack.find((layer) => layer.route)?.route;
  assert.equal(route.path, '/login');
  assert.deepEqual(route.stack.map((layer) => layer.handle.name), ['loginRateLimit', 'login']);
});

test('API security headers prohibit framing, sniffing, caching, and permissive CORS', () => {
  const headers = {};
  const res = { set(name, value) { headers[name.toLowerCase()] = value; } };
  let nextCalled = false;
  securityHeaders({}, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.equal(headers['cache-control'], 'no-store');
  assert.match(headers['content-security-policy'], /default-src 'none'/);
  assert.equal(Object.keys(headers).some((name) => name.startsWith('access-control-allow-origin')), false);
});

test('unmatched-route errors do not echo request paths or query values', () => {
  let forwarded;
  notFound({ method: 'GET', originalUrl: '/private?token=secret&mrn=MRN-123456' }, {}, (error) => { forwarded = error; });
  assert.equal(forwarded.status, 404);
  assert.equal(forwarded.message, 'Route not found');
  assert.doesNotMatch(forwarded.message, /secret|MRN|private/i);
});

test('internal errors do not expose or log database details', () => {
  const oldError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  const res = {
    statusCode: 200,
    body: null,
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; return this; }
  };
  try {
    errorHandler(new Error('mongodb://user:password@private-host/secret'), {}, res, () => {});
  } finally {
    console.error = oldError;
  }
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { success: false, message: 'Internal server error', data: null });
  assert.deepEqual(logged, ['Request failed with an internal server error']);
});

test('consent and BreakGlass audit events declare unique action-scoped database indexes', () => {
  const indexes = AuditLog.schema.indexes();
  for (const action of ['patient_consent_granted', 'patient_consent_revoked', 'break_glass_activated']) {
    const index = indexes.find(([, options]) => options.name === `unique_${action}_audit_event`);
    assert.ok(index, action);
    assert.equal(index[1].unique, true);
    assert.deepEqual(index[1].partialFilterExpression, { action, entityId: { $type: 'objectId' } });
  }
  assert.deepEqual(User.schema.path('role').enumValues, [
    'receptionist', 'doctor', 'lab_technician', 'pharmacist', 'patient', 'admin'
  ]);
});

test('audit service recovers duplicate consent audit writes by actor, action, entity, and record ID', async () => {
  const actorId = new mongoose.Types.ObjectId();
  const entityId = new mongoose.Types.ObjectId();
  const oldFindById = User.findById;
  const oldSave = AuditLog.prototype.save;
  const oldFindOne = AuditLog.findOne;
  const persisted = [];
  let saveCount = 0;
  User.findById = () => ({ select() { return this; }, lean: async () => ({ _id: actorId }) });
  AuditLog.prototype.save = async function saveMock() {
    saveCount += 1;
    if (saveCount === 1) {
      persisted.push(this.toObject({ depopulate: true }));
      return this;
    }
    const duplicate = new Error('duplicate index internals');
    duplicate.code = 11000;
    throw duplicate;
  };
  AuditLog.findOne = (filter) => ({
    select() { return this; },
    lean: async () => persisted.find((event) =>
      String(event.actor) === String(filter.actor) && event.action === filter.action &&
      event.entityType === filter.entityType && String(event.entityId) === String(filter.entityId)
    ) || null
  });
  try {
    const { writeAuditLog } = require('../services/audit-log.service');
    const input = { actorId, action: 'patient_consent_granted', entityType: 'Consent', entityId };
    const results = await Promise.all([writeAuditLog(input), writeAuditLog(input)]);
    assert.equal(saveCount, 2);
    assert.equal(persisted.length, 1);
    assert.equal(results[0].id, results[1].id);
    assert.ok(results.some((result) => result.deduplicated === true));
    assert.equal(persisted[0].details, undefined);
  } finally {
    User.findById = oldFindById;
    AuditLog.prototype.save = oldSave;
    AuditLog.findOne = oldFindOne;
  }
});
