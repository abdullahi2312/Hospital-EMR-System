'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const mongoose = require('mongoose');

process.env.JWT_SECRET = 'encounter-management-test-secret-with-enough-entropy-12345';
process.env.JWT_EXPIRES_IN = '1d';

const User = require('../models/User');
const { generateToken } = require('../utils/token');
const ids = {
  admin: new mongoose.Types.ObjectId(),
  receptionist: new mongoose.Types.ObjectId(),
  doctor: new mongoose.Types.ObjectId(),
  patient: new mongoose.Types.ObjectId(),
  patientRecord: new mongoose.Types.ObjectId(),
  labTech: new mongoose.Types.ObjectId(),
  missing: new mongoose.Types.ObjectId()
};
const users = new Map([
  [String(ids.admin), { _id: ids.admin, role: 'admin', fullName: 'Admin', username: 'admin', isActive: true }],
  [String(ids.receptionist), { _id: ids.receptionist, role: 'receptionist', fullName: 'Receptionist', username: 'receptionist', isActive: true }],
  [String(ids.doctor), { _id: ids.doctor, role: 'doctor', fullName: 'Doctor', username: 'doctor', isActive: true }],
  [String(ids.patient), { _id: ids.patient, role: 'patient', patient: ids.patientRecord, fullName: 'Patient', username: 'patient', isActive: true }],
  [String(ids.labTech), { _id: ids.labTech, role: 'lab_technician', fullName: 'Lab Tech', username: 'lab-tech', isActive: true }]
]);
const calls = [];

function serviceError(message, status, props = {}) {
  return Object.assign(new Error(message), { name: 'EncounterServiceError', status, statusCode: status, ...props });
}

const servicePath = require.resolve('../services/encounter.service');
const serviceModule = new Module(servicePath);
serviceModule.filename = servicePath;
serviceModule.loaded = true;
serviceModule.exports = {
  async createEncounter(input, user) {
    calls.push({ method: 'create', input, user });
    if (input.idempotencyKey === 'partial-create-key') {
      throw serviceError('private low-level failure', 503, { partialSuccess: true, encounterId: '507f1f77bcf86cd799439011' });
    }
    return { id: '507f1f77bcf86cd799439011', visitNumber: 'VISIT-000001', status: 'open', replayed: input.idempotencyKey === 'replay-key-0001' };
  },
  async assignEncounterDoctor(input, user) {
    calls.push({ method: 'assign', input, user });
    if (input.encounterId === '507f1f77bcf86cd799439012') throw serviceError('Encounter not found', 404);
    if (input.doctorId === 'invalid-doctor') throw serviceError('A valid doctor ID is required', 400);
    return { id: input.encounterId, assignedDoctor: input.doctorId, status: 'open' };
  },
  async listEncounters(options, user) {
    calls.push({ method: 'list', options, user });
    if (!['doctor', 'patient'].includes(user.role)) throw serviceError('This user role cannot perform this encounter operation', 403);
    if (options.page === '9') throw serviceError('Unable to retrieve encounter list', 503);
    return { encounters: [{ id: '507f1f77bcf86cd799439011', status: 'open' }], pagination: { page: Number(options.page || 1), limit: Number(options.limit || 20), total: 1, totalPages: 1 } };
  },
  async getEncounterDetails(encounterId, user) {
    calls.push({ method: 'details', encounterId, user });
    if (!['doctor', 'patient'].includes(user.role)) throw serviceError('This user role cannot perform this encounter operation', 403);
    if (encounterId === '507f1f77bcf86cd799439012') throw serviceError('Encounter not found', 404);
    return { id: encounterId, status: 'open' };
  },
  async closeEncounter(input, user) {
    calls.push({ method: 'close', input, user });
    if (input.encounterId === '507f1f77bcf86cd799439012') {
      throw serviceError('Encounter may already have been closed', 503, { partialSuccess: true, encounterId: input.encounterId });
    }
    return { id: input.encounterId, status: 'closed', closedAt: new Date('2026-01-01T00:00:00.000Z') };
  }
};
require.cache[servicePath] = serviceModule;

const diagnosisServicePath = require.resolve('../services/diagnosis.service');
const diagnosisModule = new Module(diagnosisServicePath);
diagnosisModule.filename = diagnosisServicePath;
diagnosisModule.loaded = true;
diagnosisModule.exports = {
  async getEncounterDiagnoses(encounterId, user) {
    calls.push({ method: 'existingDiagnoses', encounterId, user });
    return [];
  },
  async addDiagnosis(input, user) { calls.push({ method: 'existingAddDiagnosis', input, user }); return {}; },
  async updateEncounterNotes(input, user) { calls.push({ method: 'existingNotes', input, user }); return {}; }
};
require.cache[diagnosisServicePath] = diagnosisModule;

User.findById = (id) => ({
  select() { return this; },
  lean: async () => users.get(String(id)) || null
});

const app = require('../app');
const encounterRouter = require('../routes/encounter-management.routes');
const legacyEncounterRouter = require('../routes/encounter.routes');
const labRoutes = require('../routes/lab.routes');
const server = http.createServer(app);

function token(id, claimRole) {
  return generateToken({ id: String(id), role: claimRole });
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

test('POST /api/encounters creates for receptionist/admin and rejects spoofed fields', async () => {
  const port = server.address().port;
  const body = { patient: String(ids.patientRecord), department: 'OPD', visitType: 'outpatient', chiefComplaint: 'Cough', idempotencyKey: 'create-key-0001' };
  const response = await request(port, 'POST', '/api/encounters', token(ids.receptionist, 'admin'), body);
  assert.equal(response.status, 201);
  assert.equal(response.body.success, true);
  assert.equal(calls[0].method, 'create');
  assert.equal(calls[0].user.role, 'receptionist'); // Current database role overrides the JWT claim.
  assert.deepEqual(calls[0].input, body);

  const adminReplay = await request(port, 'POST', '/api/encounters', token(ids.admin, 'doctor'), { ...body, idempotencyKey: 'replay-key-0001' });
  assert.equal(adminReplay.status, 200);
  assert.equal(adminReplay.body.data.replayed, true);

  const spoof = await request(port, 'POST', '/api/encounters', token(ids.admin, 'admin'), { ...body, assignedDoctor: String(ids.doctor) });
  assert.equal(spoof.status, 400);
  assert.equal((await request(port, 'POST', '/api/encounters?status=closed', token(ids.admin, 'admin'), body)).status, 400);
  assert.equal(calls.length, 2);

  const forbidden = await request(port, 'POST', '/api/encounters', token(ids.doctor, 'receptionist'), body);
  assert.equal(forbidden.status, 403);
  assert.equal(calls.length, 2);
});

test('PATCH /api/encounters/:id/assign uses path identity and admin-only authorization', async () => {
  const port = server.address().port;
  const id = '507f1f77bcf86cd799439011';
  const body = { doctorId: String(ids.doctor), idempotencyKey: 'assign-key-0001' };
  const response = await request(port, 'PATCH', `/api/encounters/${id}/assign`, token(ids.admin, 'receptionist'), body);
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0].input, { encounterId: id, ...body });
  assert.equal(calls[0].user.role, 'admin');

  const spoof = await request(port, 'PATCH', `/api/encounters/${id}/assign`, token(ids.admin, 'admin'), { ...body, assignedBy: String(ids.admin) });
  assert.equal(spoof.status, 400);
  assert.equal((await request(port, 'PATCH', `/api/encounters/${id}/assign?doctor=${ids.doctor}`, token(ids.admin, 'admin'), body)).status, 400);
  const forbidden = await request(port, 'PATCH', `/api/encounters/${id}/assign`, token(ids.doctor, 'admin'), body);
  assert.equal(forbidden.status, 403);
  assert.equal(calls.length, 1);

  const invalidId = await request(port, 'PATCH', '/api/encounters/not-an-id/assign', token(ids.admin, 'admin'), body);
  assert.equal(invalidId.status, 400);
});

test('GET list and details delegate safe options and service access decisions', async () => {
  const port = server.address().port;
  const doctorToken = token(ids.doctor, 'patient');
  const listed = await request(port, 'GET', '/api/encounters?page=2&limit=25', doctorToken);
  assert.equal(listed.status, 200);
  assert.deepEqual({ ...calls[0].options }, { page: '2', limit: '25' });
  assert.equal(calls[0].user.role, 'doctor');

  const unknownQuery = await request(port, 'GET', '/api/encounters?patient=507f1f77bcf86cd799439011', doctorToken);
  assert.equal(unknownQuery.status, 400);
  const detailId = '507f1f77bcf86cd799439013';
  const details = await request(port, 'GET', `/api/encounters/${detailId}`, doctorToken);
  assert.equal(details.status, 200);
  assert.equal(calls[1].encounterId, detailId);

  const invalidId = await request(port, 'GET', '/api/encounters/bad-id', doctorToken);
  assert.equal(invalidId.status, 400);
  const extraQuery = await request(port, 'GET', `/api/encounters/${detailId}?patient=507f1f77bcf86cd799439011`, doctorToken);
  assert.equal(extraQuery.status, 400);
  const oldConsoleError = console.error;
  console.error = () => {};
  let serviceFailure;
  try {
    serviceFailure = await request(port, 'GET', '/api/encounters?page=9', doctorToken);
  } finally {
    console.error = oldConsoleError;
  }
  assert.equal(serviceFailure.status, 503);
  assert.equal(serviceFailure.body.message, 'Unable to retrieve encounter list');

  const receptionist = await request(port, 'GET', '/api/encounters', token(ids.receptionist, 'doctor'));
  assert.equal(receptionist.status, 403);
  assert.equal(calls.length, 4);
});

test('PATCH close is doctor-only, rejects body spoofing, and reports partial success accurately', async () => {
  const port = server.address().port;
  const id = '507f1f77bcf86cd799439011';
  const doctorToken = token(ids.doctor, 'admin');
  const response = await request(port, 'PATCH', `/api/encounters/${id}/close`, doctorToken, {});
  assert.equal(response.status, 200);
  assert.equal(calls[0].input.encounterId, id);
  assert.equal(Object.keys(calls[0].input).length, 1);

  const spoof = await request(port, 'PATCH', `/api/encounters/${id}/close`, doctorToken, { closedAt: '2026-01-01' });
  assert.equal(spoof.status, 400);
  const forbidden = await request(port, 'PATCH', `/api/encounters/${id}/close`, token(ids.receptionist, 'doctor'), {});
  assert.equal(forbidden.status, 403);
  assert.equal(calls.length, 1);

  const partial = await request(port, 'PATCH', '/api/encounters/507f1f77bcf86cd799439012/close', doctorToken, {});
  assert.equal(partial.status, 503);
  assert.equal(partial.body.success, false);
  assert.equal(partial.body.data.partialSuccess, true);
  assert.match(partial.body.message, /may already have succeeded/);
  assert.doesNotMatch(partial.body.message, /private low-level failure|stack|database/i);
});

test('all endpoints authenticate first and existing nested encounter routes remain mounted', async () => {
  const port = server.address().port;
  for (const [method, path, body] of [
    ['POST', '/api/encounters', {}],
    ['PATCH', '/api/encounters/507f1f77bcf86cd799439011/assign', {}],
    ['GET', '/api/encounters', undefined],
    ['GET', '/api/encounters/507f1f77bcf86cd799439011', undefined],
    ['PATCH', '/api/encounters/507f1f77bcf86cd799439011/close', {}]
  ]) {
    assert.equal((await request(port, method, path, undefined, body)).status, 401);
  }
  assert.equal((await request(port, 'GET', '/api/encounters', 'not-a-jwt')).status, 401);

  const diagnosis = await request(port, 'GET', '/api/encounters/507f1f77bcf86cd799439011/diagnoses', token(ids.doctor, 'doctor'));
  assert.equal(diagnosis.status, 200);
  assert.equal(calls.at(-1).method, 'existingDiagnoses');

  const routes = encounterRouter.stack.filter((layer) => layer.route);
  for (const expected of [
    ['/', 'post'], ['/:id/assign', 'patch'], ['/', 'get'], ['/:id', 'get'], ['/:id/close', 'patch']
  ]) {
    assert.ok(routes.some((layer) => layer.route.path === expected[0] && layer.route.methods[expected[1]]));
  }
  const createRoute = routes.find((layer) => layer.route.path === '/' && layer.route.methods.post);
  assert.deepEqual(createRoute.route.stack.map((layer) => layer.handle.name), ['authenticate', 'authorizeRequest', 'create']);
  const assignmentRoute = routes.find((layer) => layer.route.path === '/:id/assign');
  assert.deepEqual(assignmentRoute.route.stack.map((layer) => layer.handle.name), ['authenticate', 'authorizeRequest', 'assign']);
  const closeRoute = routes.find((layer) => layer.route.path === '/:id/close');
  assert.deepEqual(closeRoute.route.stack.map((layer) => layer.handle.name), ['authenticate', 'authorizeRequest', 'close']);
  assert.equal(app.router.stack.filter((layer) => layer.handle === encounterRouter).length, 1);
  const legacyPaths = legacyEncounterRouter.stack.filter((layer) => layer.route).map((layer) => layer.route.path);
  assert.ok(legacyPaths.includes('/:encounterId/vitals'));
  assert.ok(legacyPaths.includes('/:encounterId/diagnoses'));
  assert.ok(legacyPaths.includes('/:encounterId/prescriptions'));
  assert.ok(legacyPaths.includes('/:encounterId/notes'));
  const labEncounterPaths = labRoutes.encounterRouter.stack.filter((layer) => layer.route).map((layer) => layer.route.path);
  assert.ok(labEncounterPaths.includes('/:encounterId/lab-orders'));
  assert.ok(labEncounterPaths.includes('/:encounterId/lab-orders/:orderId/cancel'));
});
