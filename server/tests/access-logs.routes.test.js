'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const mongoose = require('mongoose');

process.env.JWT_SECRET = 'access-log-review-test-secret-with-adequate-entropy-12345';
process.env.JWT_EXPIRES_IN = '1d';

const User = require('../models/User');
const Patient = require('../models/Patient');
const AccessLog = require('../models/AccessLog');
const { generateToken } = require('../utils/token');

const ids = {
  admin: new mongoose.Types.ObjectId(),
  doctor: new mongoose.Types.ObjectId(),
  patient: new mongoose.Types.ObjectId(),
  patientRecord: new mongoose.Types.ObjectId(),
  actor: new mongoose.Types.ObjectId(),
  encounter: new mongoose.Types.ObjectId(),
  consent: new mongoose.Types.ObjectId(),
  breakGlass: new mongoose.Types.ObjectId()
};
const users = new Map([
  [String(ids.admin), { _id: ids.admin, fullName: 'Admin', username: 'admin', role: 'admin', isActive: true }],
  [String(ids.doctor), { _id: ids.doctor, fullName: 'Doctor', username: 'doctor', role: 'doctor', isActive: true }],
  [String(ids.patient), { _id: ids.patient, fullName: 'Patient', username: 'patient', role: 'patient', patient: ids.patientRecord, isActive: true }]
]);

const logs = [
  {
    _id: new mongoose.Types.ObjectId(), patient: ids.patientRecord, user: ids.actor, encounter: ids.encounter,
    consent: ids.consent, action: 'view_record', accessMethod: 'patient_consent',
    accessReason: 'View encounter summary', accessedAt: new Date('2026-10-20T10:00:00.000Z'),
    ipAddress: '192.0.2.10', userAgent: 'private browser details', clinicalNotes: 'must not escape'
  },
  {
    _id: new mongoose.Types.ObjectId(), patient: ids.patientRecord, user: ids.actor,
    action: 'denied_access', accessMethod: 'denied', accessedAt: new Date('2026-10-21T10:00:00.000Z')
  }
];

function queryResult(items) {
  return {
    select() { return this; },
    sort(spec) {
      items.sort((a, b) => (b.accessedAt - a.accessedAt) || String(b._id).localeCompare(String(a._id)));
      this.sortSpec = spec;
      return this;
    },
    skip(value) { this.skipValue = value; return this; },
    limit(value) { this.limitValue = value; return this; },
    async lean() { return items.slice(this.skipValue || 0, (this.skipValue || 0) + (this.limitValue || items.length)); }
  };
}

AccessLog.find = (filter) => {
  const matched = logs.filter((log) => {
    if (filter.patient && String(log.patient) !== String(filter.patient)) return false;
    if (filter.user && String(log.user) !== String(filter.user)) return false;
    if (filter.accessedAt?.$gte && log.accessedAt < filter.accessedAt.$gte) return false;
    if (filter.accessedAt?.$lte && log.accessedAt > filter.accessedAt.$lte) return false;
    return true;
  });
  return queryResult(matched);
};
AccessLog.countDocuments = async (filter) => {
  return logs.filter((log) => {
    if (filter.patient && String(log.patient) !== String(filter.patient)) return false;
    if (filter.user && String(log.user) !== String(filter.user)) return false;
    if (filter.accessedAt?.$gte && log.accessedAt < filter.accessedAt.$gte) return false;
    if (filter.accessedAt?.$lte && log.accessedAt > filter.accessedAt.$lte) return false;
    return true;
  }).length;
};

User.findById = (id) => ({ select() { return this; }, lean: async () => users.get(String(id)) || null });

const app = require('../app');
const accessLogRouter = require('../routes/access-log.routes');
const adminRouter = require('../routes/admin.routes');
const server = http.createServer(app);

function token(id, claimedRole) {
  return generateToken({ id: String(id), role: claimedRole });
}

function request(port, path, authToken) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'GET', path,
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
test.after(async () => { await new Promise((resolve) => server.close(resolve)); });

test('admin access-log review returns safe records newest first with validated pagination and filters', async () => {
  const port = server.address().port;
  const response = await request(port, `/api/admin/access-logs?patientId=${ids.patientRecord}&actorId=${ids.actor}&fromDate=2026-10-20&toDate=2026-10-21&limit=1`, token(ids.admin, 'doctor'));
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.logs.length, 1);
  assert.equal(response.body.data.logs[0].action, 'denied_access');
  assert.equal(Object.hasOwn(response.body.data.logs[0], 'ipAddress'), false);
  assert.equal(Object.hasOwn(response.body.data.logs[0], 'userAgent'), false);
  assert.equal(Object.hasOwn(response.body.data.logs[0], 'clinicalNotes'), false);
  assert.equal(response.body.data.pagination.total, 2);

  const dateFilter = await request(port, `/api/admin/access-logs?fromDate=2026-10-21T00:00:00Z&toDate=2026-10-21T23:59:59Z`, token(ids.admin, 'admin'));
  assert.equal(dateFilter.status, 200);
  assert.equal(dateFilter.body.data.logs.length, 1);
  assert.equal(dateFilter.body.data.logs[0].action, 'denied_access');
});

test('only authenticated admins can review access logs and filters are strictly validated', async () => {
  const port = server.address().port;
  assert.equal((await request(port, '/api/admin/access-logs')).status, 401);
  assert.equal((await request(port, '/api/admin/access-logs', 'invalid-token')).status, 401);
  assert.equal((await request(port, '/api/admin/access-logs', token(ids.doctor, 'admin'))).status, 403);
  assert.equal((await request(port, '/api/admin/access-logs', token(ids.patient, 'admin'))).status, 403);
  assert.equal((await request(port, '/api/admin/access-logs?limit=101', token(ids.admin, 'admin'))).status, 400);
  assert.equal((await request(port, '/api/admin/access-logs?page=0', token(ids.admin, 'admin'))).status, 400);
  assert.equal((await request(port, '/api/admin/access-logs?patientId=bad-id', token(ids.admin, 'admin'))).status, 400);
  assert.equal((await request(port, '/api/admin/access-logs?fromDate=bad-date', token(ids.admin, 'admin'))).status, 400);
  assert.equal((await request(port, '/api/admin/access-logs?fromDate=2026-10-22&toDate=2026-10-21', token(ids.admin, 'admin'))).status, 400);
  assert.equal((await request(port, '/api/admin/access-logs?password=secret', token(ids.admin, 'admin'))).status, 400);

  const route = accessLogRouter.stack.find((layer) => layer.route)?.route;
  assert.deepEqual(route.stack.map((layer) => layer.handle.name), ['authenticate', 'authorizeRequest', 'list']);
  assert.equal(adminRouter.stack.some((layer) => layer.route?.path === '/break-glass/:id/review'), true);
  assert.equal(app.router.stack.filter((layer) => layer.handle === accessLogRouter).length, 1);
});

test('AccessLog server timestamps override caller values and references/reason are validated', async () => {
  const supplied = new Date('2000-01-01T00:00:00.000Z');
  const record = new AccessLog({
    patient: ids.patientRecord, user: ids.actor, action: 'view_record', accessMethod: 'assigned_visit',
    accessedAt: supplied, createdAt: supplied, updatedAt: supplied, accessReason: 'View encounter summary'
  });
  await record.validate();
  assert.ok(record.accessedAt.getTime() > supplied.getTime());
  assert.equal(record.createdAt.getTime(), record.accessedAt.getTime());
  assert.equal(record.updatedAt.getTime(), record.accessedAt.getTime());

  await assert.rejects(new AccessLog({
    patient: 'invalid', user: ids.actor, action: 'view_record', accessMethod: 'assigned_visit'
  }).validate(), (error) => error.name === 'ValidationError');
  await assert.rejects(new AccessLog({
    patient: ids.patientRecord, user: ids.actor, action: 'view_record', accessMethod: 'assigned_visit',
    accessReason: 'Patient MRN-123456 and diagnosis details'
  }).validate(), (error) => error.name === 'ValidationError');
  assert.throws(() => new AccessLog({
    patient: ids.patientRecord, user: ids.actor, action: 'view_record', accessMethod: 'assigned_visit', customMetadata: 'private'
  }), /not in schema|strict/i);
});

test('AccessLog rejects document, query, replacement, bulk update, and delete operations', async () => {
  const doc = new AccessLog({ patient: ids.patientRecord, user: ids.actor, action: 'view_record', accessMethod: 'assigned_visit' });
  doc.$isNew = false;
  await assert.rejects(doc.save(), /append-only/);
  await assert.rejects(AccessLog.updateOne({}, { $set: { action: 'denied_access' } }).exec(), /append-only/);
  await assert.rejects(AccessLog.replaceOne({}, {}).exec(), /append-only/);
  await assert.rejects(AccessLog.deleteMany({}).exec(), /append-only/);
  await assert.rejects(AccessLog.bulkWrite([{ updateOne: { filter: {}, update: { $set: { action: 'x' } } } }]), /append-only/);
});

test('patient-access authorization fails closed when its required AccessLog write fails', async () => {
  const originalExists = Patient.exists;
  const originalCreate = AccessLog.create;
  Patient.exists = async () => true;
  AccessLog.create = async () => { throw new Error('simulated audit storage failure'); };
  try {
    const { authorizePatientRecordAccess } = require('../services/patient-access.service');
    await assert.rejects(
      authorizePatientRecordAccess(
        { id: String(ids.patient), role: 'patient', patient: String(ids.patientRecord) },
        String(ids.patientRecord)
      ),
      (error) => error.name === 'PatientAccessAuditError'
    );
  } finally {
    Patient.exists = originalExists;
    AccessLog.create = originalCreate;
  }
});
