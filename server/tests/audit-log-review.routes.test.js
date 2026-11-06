'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');

process.env.JWT_SECRET = 'audit-log-review-test-secret-with-sufficient-entropy-123456';
process.env.JWT_EXPIRES_IN = '1d';

const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { generateToken } = require('../utils/token');

const ids = {
  admin: new mongoose.Types.ObjectId(),
  inactiveAdmin: new mongoose.Types.ObjectId(),
  doctor: new mongoose.Types.ObjectId(),
  otherAdmin: new mongoose.Types.ObjectId(),
  actor: new mongoose.Types.ObjectId(),
  patient: new mongoose.Types.ObjectId(),
  encounter: new mongoose.Types.ObjectId(),
  audit1: new mongoose.Types.ObjectId('000000000000000000000001'),
  audit2: new mongoose.Types.ObjectId('000000000000000000000002'),
  audit3: new mongoose.Types.ObjectId('000000000000000000000003')
};

const accounts = new Map([
  [String(ids.admin), { _id: ids.admin, fullName: 'Admin', username: 'admin', role: 'admin', isActive: true }],
  [String(ids.inactiveAdmin), { _id: ids.inactiveAdmin, fullName: 'Inactive Admin', username: 'inactive', role: 'admin', isActive: false }],
  [String(ids.doctor), { _id: ids.doctor, fullName: 'Doctor', username: 'doctor', role: 'doctor', isActive: true }],
  [String(ids.otherAdmin), { _id: ids.otherAdmin, fullName: 'Other Admin', username: 'other-admin', role: 'admin', isActive: true }]
]);

const sameTime = new Date('2026-11-01T10:00:00.000Z');
const records = [
  {
    _id: ids.audit1, actor: ids.actor, action: 'patient_registered', entityType: 'Patient',
    entityId: ids.patient, createdAt: sameTime,
    details: { password: 'must never be exposed', clinicalNotes: 'private' },
    ipAddress: '198.51.100.20', userAgent: 'private client'
  },
  {
    _id: ids.audit2, actor: ids.actor, action: 'encounter_created', entityType: 'Encounter',
    entityId: ids.encounter, createdAt: sameTime,
    paymentDeduplicationKey: 'a'.repeat(64), patientRegistrationDeduplicationKey: 'b'.repeat(64)
  },
  {
    _id: ids.audit3, actor: ids.otherAdmin, action: 'break_glass_reviewed', entityType: 'BreakGlass',
    entityId: new mongoose.Types.ObjectId(), createdAt: new Date('2026-11-02T10:00:00.000Z'),
    details: { decision: 'justified' }
  }
];

const originalFindById = User.findById;
const originalFind = AuditLog.find;
const originalCountDocuments = AuditLog.countDocuments;
const queryCalls = [];

function matches(record, filter) {
  for (const field of ['actor', 'action', 'entityType', 'entityId']) {
    if (filter[field] && String(record[field]) !== String(filter[field])) return false;
  }
  const range = filter.createdAt;
  if (range?.$gte && record.createdAt < range.$gte) return false;
  if (range?.$lte && record.createdAt > range.$lte) return false;
  return true;
}

AuditLog.find = (filter) => {
  const call = { filter, projection: null, sort: null, skip: null, limit: null };
  queryCalls.push(call);
  let matched = records.filter((record) => matches(record, filter));
  return {
    select(projection) { call.projection = projection; return this; },
    sort(sort) {
      call.sort = sort;
      matched = matched.sort((left, right) =>
        (right.createdAt - left.createdAt) || String(right._id).localeCompare(String(left._id))
      );
      return this;
    },
    skip(skip) { call.skip = skip; return this; },
    limit(limit) { call.limit = limit; return this; },
    async lean() { return matched.slice(call.skip, call.skip + call.limit); }
  };
};
AuditLog.countDocuments = async (filter) => records.filter((record) => matches(record, filter)).length;
User.findById = (id) => ({
  select() { return this; },
  lean: async () => accounts.get(String(id)) || null
});

const app = require('../app');
const auditLogRouter = require('../routes/audit-log.routes');
const accessLogRouter = require('../routes/access-log.routes');
const server = http.createServer(app);

function token(id, claimedRole) {
  return generateToken({ id: String(id), role: claimedRole });
}

function request(port, method, path, authToken) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path, agent: false,
      headers: authToken ? { authorization: `Bearer ${authToken}` } : {}
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

test.before(async () => { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); });
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  User.findById = originalFindById;
  AuditLog.find = originalFind;
  AuditLog.countDocuments = originalCountDocuments;
});
test.beforeEach(() => { queryCalls.length = 0; });

test('admin can review paginated audit logs using safe filters and a safe projection', async () => {
  const port = server.address().port;
  const response = await request(
    port,
    'GET',
    `/api/admin/audit-logs?actorId=${ids.actor}&action=patient_registered&entityType=Patient&entityId=${ids.patient}&fromDate=2026-11-01&toDate=2026-11-01&limit=10`,
    token(ids.admin, 'doctor')
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.logs.length, 1);
  const record = response.body.data.logs[0];
  assert.deepEqual(Object.keys(record).sort(), ['action', 'actorId', 'createdAt', 'entityId', 'entityType', 'id']);
  assert.equal(record.action, 'patient_registered');
  assert.equal(record.actorId, String(ids.actor));
  for (const privateField of ['details', 'ipAddress', 'userAgent', 'paymentDeduplicationKey', 'patientRegistrationDeduplicationKey', 'password', 'clinicalNotes']) {
    assert.equal(Object.hasOwn(record, privateField), false);
  }
  assert.equal(response.body.data.pagination.total, 1);
  assert.deepEqual(queryCalls[0].sort, { createdAt: -1, _id: -1 });
  assert.equal(queryCalls[0].projection, '_id actor action entityType entityId createdAt');
});

test('audit-log review requires an active database admin and rejects spoofed JWT roles', async () => {
  const port = server.address().port;
  assert.equal((await request(port, 'GET', '/api/admin/audit-logs')).status, 401);
  assert.equal((await request(port, 'GET', '/api/admin/audit-logs', 'not-a-token')).status, 401);
  assert.equal((await request(port, 'GET', '/api/admin/audit-logs', token(ids.inactiveAdmin, 'admin'))).status, 401);
  assert.equal((await request(port, 'GET', '/api/admin/audit-logs', token(ids.doctor, 'admin'))).status, 403);
  assert.equal((await request(port, 'GET', '/api/admin/audit-logs', token(ids.admin, 'doctor'))).status, 200);
});

test('pagination and supported query parameters are strictly validated', async () => {
  const port = server.address().port;
  const adminToken = token(ids.admin, 'admin');
  for (const query of [
    '?page=0', '?page=1.2', '?limit=101', '?limit=abc', `?actorId=not-id`,
    '?entityId=nope', '?action=', `?action=${'x'.repeat(121)}`,
    '?fromDate=not-a-date', '?toDate=2026-02-30',
    '?fromDate=2026-11-02&toDate=2026-11-01', '?details=true'
  ]) {
    const response = await request(port, 'GET', `/api/admin/audit-logs${query}`, adminToken);
    assert.equal(response.status, 400, query);
    assert.equal(response.body.success, false, query);
    assert.equal(response.body.data, null, query);
  }
});

test('pagination is stable newest-first and the endpoint is read-only and mounted once', async () => {
  const port = server.address().port;
  const adminToken = token(ids.admin, 'admin');
  const pageOne = await request(port, 'GET', '/api/admin/audit-logs?limit=2', adminToken);
  const pageTwo = await request(port, 'GET', '/api/admin/audit-logs?page=2&limit=2', adminToken);
  assert.equal(pageOne.status, 200);
  assert.equal(pageOne.body.data.logs[0].id, String(ids.audit3));
  assert.equal(pageOne.body.data.logs[1].id, String(ids.audit2));
  assert.equal(pageTwo.body.data.logs[0].id, String(ids.audit1));
  assert.equal(pageOne.body.data.pagination.total, 3);
  assert.equal(pageOne.body.data.pagination.totalPages, 2);
  assert.equal((await request(port, 'POST', '/api/admin/audit-logs', adminToken)).status, 404);
  assert.equal((await request(port, 'PATCH', '/api/admin/audit-logs', adminToken)).status, 404);
  assert.equal((await request(port, 'DELETE', '/api/admin/audit-logs', adminToken)).status, 404);

  const routeLayers = auditLogRouter.stack.filter((layer) => layer.route);
  assert.equal(routeLayers.length, 1);
  assert.deepEqual({ ...routeLayers[0].route.methods }, { get: true });
  assert.deepEqual(routeLayers[0].route.stack.map((layer) => layer.handle.name), [
    'authenticate', 'authorizeRequest', 'list'
  ]);
  assert.equal(app.router.stack.filter((layer) => layer.handle === auditLogRouter).length, 1);
  assert.equal(app.router.stack.some((layer) => layer.handle === accessLogRouter), true);
});
