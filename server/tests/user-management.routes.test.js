'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const mongoose = require('mongoose');

process.env.JWT_SECRET = 'user-management-routes-test-secret-with-sufficient-entropy-12345';
process.env.JWT_EXPIRES_IN = '1d';

const User = require('../models/User');
const { generateToken } = require('../utils/token');
const ids = {
  admin: new mongoose.Types.ObjectId(),
  inactiveAdmin: new mongoose.Types.ObjectId(),
  doctor: new mongoose.Types.ObjectId(),
  receptionist: new mongoose.Types.ObjectId(),
  patient: new mongoose.Types.ObjectId(),
  patientRecord: new mongoose.Types.ObjectId(),
  missing: new mongoose.Types.ObjectId()
};
const accounts = new Map([
  [String(ids.admin), { _id: ids.admin, fullName: 'Admin', username: 'admin', role: 'admin', isActive: true }],
  [String(ids.inactiveAdmin), { _id: ids.inactiveAdmin, fullName: 'Inactive Admin', username: 'inactive-admin', role: 'admin', isActive: false }],
  [String(ids.doctor), { _id: ids.doctor, fullName: 'Doctor', username: 'doctor', role: 'doctor', isActive: true }],
  [String(ids.receptionist), { _id: ids.receptionist, fullName: 'Receptionist', username: 'receptionist', role: 'receptionist', isActive: true }],
  [String(ids.patient), { _id: ids.patient, fullName: 'Patient', username: 'patient', role: 'patient', patient: ids.patientRecord, isActive: true }]
]);
const calls = [];
const managementPath = require.resolve('../services/user-management.service');
const managementModule = new Module(managementPath);
managementModule.filename = managementPath;
managementModule.loaded = true;
managementModule.exports = {
  async createManagedUser(input, user) {
    calls.push({ method: 'create', input, user });
    if (input.role === 'admin') throw Object.assign(new Error('Admin accounts cannot be created through ordinary provisioning'), { name: 'UserManagementServiceError', status: 403 });
    if (input.username === 'service-error') throw Object.assign(new Error('Username already exists'), { name: 'UserManagementServiceError', status: 409 });
    if (input.username === 'partial-create') {
      throw Object.assign(new Error('private audit failure detail'), {
        name: 'UserManagementServiceError', status: 503, partialSuccess: true,
        userId: '507f1f77bcf86cd799439011'
      });
    }
    return {
      id: '507f1f77bcf86cd799439011', fullName: input.fullName, username: input.username,
      role: input.role, ...(input.patient ? { patient: input.patient } : {}), isActive: true,
      createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
      phone: input.phone, password: input.password, passwordHash: '$2b$12$private', token: 'private-token',
      idempotencyKey: input.idempotencyKey, auditMetadata: { secret: true }, clinicalNotes: 'private'
    };
  },
  async listManagedUsers(options, user) {
    calls.push({ method: 'list', options, user });
    if (options.page === '9') throw Object.assign(new Error('Unable to retrieve users'), { name: 'UserManagementServiceError', status: 503 });
    return {
      users: [{ id: '507f1f77bcf86cd799439011', fullName: 'Visible User', username: 'visible', role: 'doctor', isActive: true,
        password: 'plain', passwordHash: '$2b$12$private', phone: 'private', clinicalNotes: 'private', patientClinicalData: { diagnosis: 'private' } }],
      pagination: { page: Number(options.page || 1), limit: Number(options.limit || 20), total: 1, totalPages: 1 }
    };
  },
  async getManagedUser(userId, user) {
    calls.push({ method: 'get', userId, user });
    if (userId === '507f1f77bcf86cd799439012') {
      throw Object.assign(new Error('User not found'), { name: 'UserManagementServiceError', status: 404 });
    }
    return { id: userId, fullName: 'Visible User', username: 'visible', role: 'doctor', isActive: true,
      passwordHash: '$2b$12$private', phone: 'private', credentials: 'private', patientClinicalData: { diagnosis: 'private' } };
  },
  async updateManagedUserStatus(input, user) {
    calls.push({ method: 'status', input, user });
    if (input.isActive === false && input.idempotencyKey === 'partial-status-key') {
      throw Object.assign(new Error('private audit failure detail'), {
        name: 'UserManagementServiceError', status: 503, partialSuccess: true,
        userId: input.userId
      });
    }
    return { id: input.userId, fullName: 'Visible User', username: 'visible', role: 'doctor', isActive: input.isActive,
      passwordHash: '$2b$12$private', phone: 'private', auditMetadata: { internal: true } };
  }
};
require.cache[managementPath] = managementModule;

const reviewPath = require.resolve('../services/break-glass-review.service');
const reviewModule = new Module(reviewPath);
reviewModule.filename = reviewPath;
reviewModule.loaded = true;
reviewModule.exports = {
  async reviewBreakGlassAuthorization(user, id, decision, notes) {
    calls.push({ method: 'breakGlassReview', user, id, decision, notes });
    return { id, status: decision, reviewedAt: new Date('2026-01-01T00:00:00Z') };
  }
};
require.cache[reviewPath] = reviewModule;

User.findById = (id) => ({
  select() { return this; },
  lean: async () => accounts.get(String(id)) || null
});

const app = require('../app');
const router = require('../routes/user-management.routes');
const adminRouter = require('../routes/admin.routes');
const server = http.createServer(app);

function token(id, claimedRole) {
  return generateToken({ id: String(id), role: claimedRole });
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

test('POST /api/admin/users creates provisionable accounts and returns only safe fields', async () => {
  const port = server.address().port;
  const body = { fullName: 'New Doctor', username: 'new.doctor', password: 'Valid Password 123!', role: 'doctor', idempotencyKey: 'create-managed-0001' };
  const response = await request(port, 'POST', '/api/admin/users', token(ids.admin, 'doctor'), body);
  assert.equal(response.status, 201);
  assert.equal(response.body.success, true);
  assert.equal(calls[0].method, 'create');
  assert.deepEqual(calls[0].input, body);
  assert.equal(calls[0].user.role, 'admin');
  assert.equal(Object.hasOwn(response.body.data, 'password'), false);
  assert.equal(Object.hasOwn(response.body.data, 'passwordHash'), false);
  assert.equal(Object.hasOwn(response.body.data, 'phone'), false);
  assert.equal(Object.hasOwn(response.body.data, 'token'), false);
  assert.equal(Object.hasOwn(response.body.data, 'auditMetadata'), false);
  assert.equal(Object.hasOwn(response.body.data, 'clinicalNotes'), false);

  const patientBody = { fullName: 'Portal User', username: 'portal.user', password: 'Valid Password 123!', role: 'patient', patient: String(ids.patientRecord), idempotencyKey: 'patient-managed-0001' };
  const patientResponse = await request(port, 'POST', '/api/admin/users', token(ids.admin, 'admin'), patientBody);
  assert.equal(patientResponse.status, 201);
  assert.equal(patientResponse.body.data.patient, String(ids.patientRecord));

  const invalidLink = await request(port, 'POST', '/api/admin/users', token(ids.admin, 'admin'), { ...body, username: 'bad-link', patient: String(ids.patientRecord) });
  assert.equal(invalidLink.status, 400);
  const adminAttempt = await request(port, 'POST', '/api/admin/users', token(ids.admin, 'admin'), { ...body, username: 'admin-attempt', role: 'admin' });
  assert.equal(adminAttempt.status, 403);

  for (const field of ['actorId', 'passwordHash', 'createdAt', 'updatedAt', 'isActive']) {
    const spoofed = await request(port, 'POST', '/api/admin/users', token(ids.admin, 'admin'), {
      ...body, username: `spoof-${field}`, [field]: 'client-value'
    });
    assert.equal(spoofed.status, 400, `create must reject ${field}`);
  }

  const partial = await request(port, 'POST', '/api/admin/users', token(ids.admin, 'admin'), {
    ...body, username: 'partial-create'
  });
  assert.equal(partial.status, 503);
  assert.equal(partial.body.data.partialSuccess, true);
  assert.match(partial.body.message, /check the existing account before retrying/i);
  assert.doesNotMatch(JSON.stringify(partial.body), /private audit failure detail|passwordHash|database|stack/i);

  const conflict = await request(port, 'POST', '/api/admin/users', token(ids.admin, 'admin'), {
    ...body, username: 'service-error'
  });
  assert.equal(conflict.status, 409);
});

test('GET list and detail validate filters and protect user projections', async () => {
  const port = server.address().port;
  const auth = token(ids.admin, 'admin');
  const listed = await request(port, 'GET', '/api/admin/users?page=2&limit=25', auth);
  assert.equal(listed.status, 200);
  assert.deepEqual({ ...calls[0].options }, { page: '2', limit: '25' });
  assert.equal(Object.hasOwn(listed.body.data.users[0], 'password'), false);
  assert.equal(Object.hasOwn(listed.body.data.users[0], 'passwordHash'), false);
  assert.equal(Object.hasOwn(listed.body.data.users[0], 'phone'), false);
  assert.equal(Object.hasOwn(listed.body.data.users[0], 'patientClinicalData'), false);

  assert.equal((await request(port, 'GET', '/api/admin/users?limit=101', auth)).status, 400);
  assert.equal((await request(port, 'GET', '/api/admin/users?role=admin', auth)).status, 400);
  const unavailable = await request(port, 'GET', '/api/admin/users?page=9', auth);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.message, 'Unable to complete the user-management request');
  assert.doesNotMatch(JSON.stringify(unavailable.body), /database|stack|passwordHash|private/i);
  const userId = '507f1f77bcf86cd799439011';
  const details = await request(port, 'GET', `/api/admin/users/${userId}`, auth);
  assert.equal(details.status, 200);
  assert.equal(calls.find((call) => call.method === 'get').userId, userId);
  assert.equal(Object.hasOwn(details.body.data, 'credentials'), false);
  assert.equal((await request(port, 'GET', '/api/admin/users/not-an-id', auth)).status, 400);
  assert.equal((await request(port, 'GET', '/api/admin/users/507f1f77bcf86cd799439012', auth)).status, 404);
});

test('PATCH status uses the route user ID, strict allowlists, and safe partial-success response', async () => {
  const port = server.address().port;
  const auth = token(ids.admin, 'patient');
  const userId = '507f1f77bcf86cd799439011';
  const response = await request(port, 'PATCH', `/api/admin/users/${userId}/status`, auth, { isActive: false, idempotencyKey: 'status-managed-0001' });
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0].input, { userId, isActive: false, idempotencyKey: 'status-managed-0001' });
  assert.equal(calls[0].user.role, 'admin');
  assert.equal(Object.hasOwn(response.body.data, 'passwordHash'), false);

  const spoof = await request(port, 'PATCH', `/api/admin/users/${userId}/status`, auth, { isActive: false, idempotencyKey: 'status-managed-0002', role: 'admin' });
  assert.equal(spoof.status, 400);
  const invalidId = await request(port, 'PATCH', '/api/admin/users/bad-id/status', auth, { isActive: false, idempotencyKey: 'status-managed-0003' });
  assert.equal(invalidId.status, 400);

  const partial = await request(port, 'PATCH', `/api/admin/users/${userId}/status`, auth, { isActive: false, idempotencyKey: 'partial-status-key' });
  assert.equal(partial.status, 503);
  assert.equal(partial.body.success, false);
  assert.equal(partial.body.data.partialSuccess, true);
  assert.match(partial.body.message, /may already have succeeded/);
  assert.doesNotMatch(partial.body.message, /private audit failure detail|stack|database/i);
});

test('authentication and admin middleware protect every route; BreakGlass review stays mounted', async () => {
  const port = server.address().port;
  for (const [method, path, body] of [
    ['POST', '/api/admin/users', {}],
    ['GET', '/api/admin/users', undefined],
    ['GET', '/api/admin/users/507f1f77bcf86cd799439011', undefined],
    ['PATCH', '/api/admin/users/507f1f77bcf86cd799439011/status', {}]
  ]) {
    assert.equal((await request(port, method, path, undefined, body)).status, 401);
    assert.equal((await request(port, method, path, 'invalid-token', body)).status, 401);
  }
  assert.equal((await request(port, 'GET', '/api/admin/users', token(ids.doctor, 'admin'))).status, 403);
  assert.equal((await request(port, 'GET', '/api/admin/users', token(ids.receptionist, 'admin'))).status, 403);
  assert.equal((await request(port, 'GET', '/api/admin/users', token(ids.inactiveAdmin, 'admin'))).status, 401);
  assert.equal(calls.length, 0);

  const review = await request(port, 'PATCH', '/api/admin/break-glass/507f1f77bcf86cd799439011/review', token(ids.admin, 'admin'), { decision: 'justified', notes: 'Reviewed for emergency care' });
  assert.equal(review.status, 200);
  assert.equal(calls[0].method, 'breakGlassReview');

  const routes = router.stack.filter((layer) => layer.route);
  for (const [path, method] of [['/', 'post'], ['/', 'get'], ['/:userId', 'get'], ['/:userId/status', 'patch']]) {
    assert.ok(routes.some((layer) => layer.route.path === path && layer.route.methods[method]));
  }
  for (const layer of routes) {
    assert.deepEqual(layer.route.stack.slice(0, 2).map((item) => item.handle.name), ['authenticate', 'authorizeRequest']);
  }
  assert.ok(adminRouter.stack.some((layer) => layer.route?.path === '/break-glass/:id/review'));
  assert.equal(app.router.stack.filter((layer) => layer.handle === router).length, 1);
});
