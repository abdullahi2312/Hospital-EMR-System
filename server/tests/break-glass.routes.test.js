'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const mongoose = require('mongoose');

process.env.JWT_SECRET = 'break-glass-api-test-secret-with-adequate-entropy-12345';
process.env.JWT_EXPIRES_IN = '1d';

const User = require('../models/User');
const { generateToken } = require('../utils/token');
const ids = {
  doctor: new mongoose.Types.ObjectId(),
  inactiveDoctor: new mongoose.Types.ObjectId(),
  receptionist: new mongoose.Types.ObjectId(),
  patient: new mongoose.Types.ObjectId(),
  patientRecord: new mongoose.Types.ObjectId(),
  missing: new mongoose.Types.ObjectId(),
  authorization: new mongoose.Types.ObjectId(),
  admin: new mongoose.Types.ObjectId()
};
const users = new Map([
  [String(ids.doctor), { _id: ids.doctor, fullName: 'Doctor', username: 'doctor', role: 'doctor', isActive: true }],
  [String(ids.inactiveDoctor), { _id: ids.inactiveDoctor, fullName: 'Inactive', username: 'inactive', role: 'doctor', isActive: false }],
  [String(ids.receptionist), { _id: ids.receptionist, fullName: 'Receptionist', username: 'receptionist', role: 'receptionist', isActive: true }],
  [String(ids.patient), { _id: ids.patient, fullName: 'Patient', username: 'patient', role: 'patient', isActive: true }],
  [String(ids.admin), { _id: ids.admin, fullName: 'Admin', username: 'admin', role: 'admin', isActive: true }]
]);
const calls = [];

const createPath = require.resolve('../services/break-glass.service');
const createModule = new Module(createPath);
createModule.filename = createPath;
createModule.loaded = true;
createModule.exports = {
  async createBreakGlassAuthorization(user, patientId, reason) {
    calls.push({ user, patientId, reason });
    if (reason.startsWith('partial')) {
      throw Object.assign(new Error('private notification failure'), {
        name: 'BreakGlassServiceError', status: 500, breakGlassMayRemainWithoutNotifications: true,
        breakGlassId: String(ids.authorization)
      });
    }
    if (reason.startsWith('audit-partial')) {
      throw Object.assign(new Error('private audit failure'), {
        name: 'BreakGlassServiceError', status: 503, breakGlassMayRemainWithoutAudit: true,
        breakGlassId: String(ids.authorization)
      });
    }
    if (reason.startsWith('failure')) {
      throw Object.assign(new Error('private internal error'), { name: 'BreakGlassServiceError', status: 500 });
    }
    if (reason.startsWith('missing')) {
      throw Object.assign(new Error('Patient not found'), { name: 'BreakGlassServiceError', status: 404 });
    }
    const activatedAt = new Date('2026-11-06T10:00:00.000Z');
    return {
      id: String(ids.authorization), patient: patientId, doctor: user.id, reason,
      status: 'active', activatedAt,
      expiresAt: new Date(activatedAt.getTime() + 24 * 60 * 60 * 1000),
      notificationStatus: 'sent', notificationCount: 2
    };
  }
};
require.cache[createPath] = createModule;

const reviewPath = require.resolve('../services/break-glass-review.service');
const reviewModule = new Module(reviewPath);
reviewModule.filename = reviewPath;
reviewModule.loaded = true;
reviewModule.exports = {
  async reviewBreakGlassAuthorization(user, id, decision, notes) {
    calls.push({ method: 'review', user, id, decision, notes });
    return { id, status: decision };
  }
};
require.cache[reviewPath] = reviewModule;

User.findById = (id) => ({ select() { return this; }, lean: async () => users.get(String(id)) || null });

const app = require('../app');
const breakGlassRouter = require('../routes/break-glass.routes');
const adminRouter = require('../routes/admin.routes');
const server = http.createServer(app);

function token(id, role) {
  return generateToken({ id: String(id), role });
}

function request(port, method, path, authToken, body) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: {
        ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
        ...(encoded !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) } : {})
      }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    if (encoded !== undefined) req.write(encoded);
    req.end();
  });
}

test.before(async () => { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); });
test.after(async () => { await new Promise((resolve) => server.close(resolve)); });
test.beforeEach(() => { calls.length = 0; });

test('active doctor activates break-glass through the service with server-authenticated identity', async () => {
  const port = server.address().port;
  const reason = 'Urgent emergency assessment requires immediate record access';
  const response = await request(port, 'POST', `/api/patients/${ids.patientRecord}/break-glass`, token(ids.doctor, 'admin'), { reason });
  assert.equal(response.status, 201);
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.doctor, String(ids.doctor));
  assert.equal(response.body.data.status, 'active');
  assert.equal(response.body.data.notificationCount, 2);
  assert.equal(new Date(response.body.data.expiresAt).getTime() - new Date(response.body.data.activatedAt).getTime(), 24 * 60 * 60 * 1000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].user.id, String(ids.doctor));
  assert.equal(calls[0].user.role, 'doctor');
  assert.equal(calls[0].patientId, String(ids.patientRecord));
});

test('reason and patient input are validated; identity spoofing is rejected', async () => {
  const port = server.address().port;
  const auth = token(ids.doctor, 'doctor');
  for (const reason of [undefined, 'too short']) {
    assert.equal((await request(port, 'POST', `/api/patients/${ids.patientRecord}/break-glass`, auth, reason === undefined ? {} : { reason })).status, 400);
  }
  assert.equal((await request(port, 'POST', '/api/patients/not-an-id/break-glass', auth, { reason: 'Long enough emergency reason for access' })).status, 400);
  for (const field of ['doctorId', 'userId', 'actorId', 'patientId']) {
    const response = await request(port, 'POST', `/api/patients/${ids.patientRecord}/break-glass`, auth, {
      reason: 'Long enough emergency reason for access', [field]: String(ids.admin)
    });
    assert.equal(response.status, 400, `must reject ${field}`);
  }
  assert.equal(calls.length, 0);
});

test('only active doctors may activate break-glass; missing and invalid tokens are rejected', async () => {
  const port = server.address().port;
  const path = `/api/patients/${ids.patientRecord}/break-glass`;
  const body = { reason: 'Long enough emergency reason for access' };
  assert.equal((await request(port, 'POST', path, undefined, body)).status, 401);
  assert.equal((await request(port, 'POST', path, 'invalid-token', body)).status, 401);
  assert.equal((await request(port, 'POST', path, token(ids.receptionist, 'doctor'), body)).status, 403);
  assert.equal((await request(port, 'POST', path, token(ids.patient, 'doctor'), body)).status, 403);
  assert.equal((await request(port, 'POST', path, token(ids.inactiveDoctor, 'doctor'), body)).status, 401);
  assert.equal(calls.length, 0);
});

test('service failures are safe and notification partial success is explicit', async () => {
  const port = server.address().port;
  const path = `/api/patients/${ids.patientRecord}/break-glass`;
  const auth = token(ids.doctor, 'doctor');
  const partial = await request(port, 'POST', path, auth, { reason: 'partial notification outcome with valid length' });
  assert.equal(partial.status, 503);
  assert.equal(partial.body.data.partialSuccess, true);
  assert.equal(partial.body.data.authorizationId, String(ids.authorization));
  assert.match(partial.body.message, /notifications may be incomplete/i);
  assert.doesNotMatch(JSON.stringify(partial.body), /private notification failure|stack|database/i);

  const auditPartial = await request(port, 'POST', path, auth, { reason: 'audit-partial outcome has a valid emergency reason' });
  assert.equal(auditPartial.status, 503);
  assert.equal(auditPartial.body.data.partialSuccess, true);
  assert.match(auditPartial.body.message, /audit logging may be incomplete/i);
  assert.doesNotMatch(JSON.stringify(auditPartial.body), /private audit failure|stack|database/i);

  const oldConsoleError = console.error;
  console.error = () => {};
  let failed;
  try {
    failed = await request(port, 'POST', path, auth, { reason: 'failure internal error with enough length' });
  } finally {
    console.error = oldConsoleError;
  }
  assert.equal(failed.status, 500);
  assert.equal(failed.body.message, 'Internal server error');
  assert.doesNotMatch(JSON.stringify(failed.body), /private internal error|stack|database/i);
});

test('route uses authenticate then doctor authorization and the existing admin review route still works', async () => {
  const port = server.address().port;
  const review = await request(
    port, 'PATCH', `/api/admin/break-glass/${ids.authorization}/review`, token(ids.admin, 'doctor'),
    { decision: 'justified', notes: 'Review completed' }
  );
  assert.equal(review.status, 200);
  assert.equal(calls[0].method, 'review');

  const route = breakGlassRouter.stack.find((layer) => layer.route)?.route;
  assert.equal(route.path, '/:patientId/break-glass');
  assert.deepEqual(route.stack.map((layer) => layer.handle.name), ['authenticate', 'authorizeRequest', 'activate']);
  assert.equal(app.router.stack.filter((layer) => layer.handle === breakGlassRouter).length, 1);
  assert.equal(adminRouter.stack.some((layer) => layer.route?.path === '/break-glass/:id/review'), true);
});
