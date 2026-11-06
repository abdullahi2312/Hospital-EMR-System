'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const mongoose = require('mongoose');

process.env.JWT_SECRET = 'vital-service-test-secret-with-sufficient-entropy-123456';
process.env.JWT_EXPIRES_IN = '1d';

const User = require('../models/User');
const Patient = require('../models/Patient');
const Encounter = require('../models/Encounter');
const Vital = require('../models/Vital');
const AuditLog = require('../models/AuditLog');
const { generateToken } = require('../utils/token');
const ids = {
  doctor: new mongoose.Types.ObjectId(),
  receptionist: new mongoose.Types.ObjectId(),
  patient: new mongoose.Types.ObjectId(),
  encounter: new mongoose.Types.ObjectId(),
  otherEncounter: new mongoose.Types.ObjectId()
};

const patientAccessPath = require.resolve('../services/patient-access.service');
const originalPatientAccessModule = require.cache[patientAccessPath];
let patientAccessAllowed = true;
const patientAccessModule = new Module(patientAccessPath);
patientAccessModule.filename = patientAccessPath;
patientAccessModule.loaded = true;
patientAccessModule.exports = {
  async authorizePatientRecordAccess(user, patientId, encounterId) {
    accessCallCount += 1;
    if (!patientAccessAllowed || String(patientId) !== String(ids.patient) ||
        ![String(ids.encounter), String(ids.otherEncounter)].includes(String(encounterId))) {
      return { allowed: false, statusCode: 403, message: 'Access denied' };
    }
    return { allowed: true, accessMethod: 'assigned_visit' };
  }
};
require.cache[patientAccessPath] = patientAccessModule;

const { recordVitals, getEncounterVitals } = require('../services/vital.service');
const app = require('../app');
const server = http.createServer(app);
const originalMethods = {
  userFindById: User.findById,
  patientExists: Patient.exists,
  encounterFindById: Encounter.findById,
  vitalFindById: Vital.findById,
  vitalFind: Vital.find,
  vitalSave: Vital.prototype.save,
  auditFindOne: AuditLog.findOne,
  auditSave: AuditLog.prototype.save
};

let currentRole = 'doctor';
let currentActive = true;
let encounterRecords;
let vitalRecords;
let auditRecords;
let accessCallCount;

function query(value) {
  return { select() { return this; }, async lean() { return value; } };
}

function resetState() {
  currentRole = 'doctor';
  currentActive = true;
  patientAccessAllowed = true;
  accessCallCount = 0;
  encounterRecords = new Map([
    [String(ids.encounter), { _id: ids.encounter, patient: ids.patient, assignedDoctor: ids.doctor }],
    [String(ids.otherEncounter), { _id: ids.otherEncounter, patient: ids.patient, assignedDoctor: new mongoose.Types.ObjectId() }]
  ]);
  vitalRecords = new Map();
  auditRecords = [];
}

User.findById = (id) => query(String(id) === String(ids.doctor)
  ? { _id: ids.doctor, role: currentRole, isActive: currentActive }
  : String(id) === String(ids.receptionist)
    ? { _id: ids.receptionist, role: 'receptionist', isActive: true }
    : null);
Patient.exists = async ({ _id }) => String(_id) === String(ids.patient) ? { _id } : null;
Encounter.findById = (id) => query(encounterRecords.get(String(id)) || null);
Vital.findById = (id) => query(vitalRecords.get(String(id)) || null);
Vital.find = (filter) => {
  let found = [...vitalRecords.values()].filter((vital) =>
    String(vital.encounter) === String(filter.encounter) && String(vital.patient) === String(filter.patient)
  );
  return {
    sort() { found = found.sort((a, b) => b.recordedAt - a.recordedAt || String(b._id).localeCompare(String(a._id))); return this; },
    async lean() { return found; }
  };
};
Vital.prototype.save = async function saveMock() {
  const saved = this.toObject({ depopulate: true });
  vitalRecords.set(String(this._id), saved);
  return this;
};
AuditLog.findOne = (filter) => query(auditRecords.find((record) =>
  String(record.actor) === String(filter.actor) && record.action === filter.action &&
  record.entityType === filter.entityType && String(record.entityId) === String(filter.entityId)
) || null);
AuditLog.prototype.save = async function saveAuditMock() {
  auditRecords.push(this.toObject({ depopulate: true }));
  return this;
};

const input = (overrides = {}) => ({
  patient: String(ids.patient),
  encounter: String(ids.encounter),
  bloodPressure: { systolic: 120, diastolic: 80 },
  temperature: 37,
  heartRate: 72,
  weight: 65,
  idempotencyKey: 'vital-test-key-0001',
  ...overrides
});
const user = (id = ids.doctor) => ({ id: String(id), role: 'doctor' });

function request(port, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path, agent: false,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
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
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  User.findById = originalMethods.userFindById;
  Patient.exists = originalMethods.patientExists;
  Encounter.findById = originalMethods.encounterFindById;
  Vital.findById = originalMethods.vitalFindById;
  Vital.find = originalMethods.vitalFind;
  Vital.prototype.save = originalMethods.vitalSave;
  AuditLog.findOne = originalMethods.auditFindOne;
  AuditLog.prototype.save = originalMethods.auditSave;
  if (originalPatientAccessModule) require.cache[patientAccessPath] = originalPatientAccessModule;
  else delete require.cache[patientAccessPath];
});
test.beforeEach(resetState);

test('records normal vitals with fixed units and backward-compatible pulse output', async () => {
  const result = await recordVitals(input({ respiratoryRate: 16, oxygenSaturation: 98, height: 170 }), user());
  assert.equal(result.pulse, 72);
  assert.equal(result.heartRate, 72);
  assert.equal(result.respiratoryRate, 16);
  assert.deepEqual(result.units, {
    bloodPressure: 'mmHg', heartRate: 'beats/min', pulse: 'beats/min',
    respiratoryRate: 'breaths/min', temperature: '°C', oxygenSaturation: '%', weight: 'kg', height: 'cm'
  });
  assert.deepEqual(result.abnormalFlags, []);
  assert.equal(auditRecords.length, 1);

  const apiInput = input({ respiratoryRate: 16, oxygenSaturation: 98, idempotencyKey: 'http-vital-key-0001' });
  delete apiInput.encounter;
  const response = await request(server.address().port, 'POST', `/api/encounters/${ids.encounter}/vitals`,
    generateToken({ id: String(ids.doctor), role: 'doctor' }), apiInput);
  assert.equal(response.status, 201);
  assert.equal(response.body.data.heartRate, 72);
  assert.equal(response.body.data.respiratoryRate, 16);
  assert.deepEqual(response.body.data.abnormalFlags, []);
});

test('abnormal but physiologically possible readings receive server-calculated flags', async () => {
  const result = await recordVitals(input({
    bloodPressure: { systolic: 85, diastolic: 55 }, temperature: 39,
    pulse: 130, heartRate: 130, respiratoryRate: 30, oxygenSaturation: 88
  }), user());
  assert.deepEqual(result.abnormalFlags, [
    { measurement: 'systolic', status: 'low' },
    { measurement: 'diastolic', status: 'low' },
    { measurement: 'temperature', status: 'high' },
    { measurement: 'pulse', status: 'high' },
    { measurement: 'respiratoryRate', status: 'high' },
    { measurement: 'oxygenSaturation', status: 'low' }
  ]);
  assert.equal(vitalRecords.size, 1);
});

test('adult reference thresholds are configurable and affect flags without changing stored values', async () => {
  const names = [
    'VITAL_FLAG_HEART_RATE_LOW_BPM', 'VITAL_FLAG_HEART_RATE_HIGH_BPM',
    'VITAL_FLAG_RESPIRATORY_RATE_LOW_PER_MIN', 'VITAL_FLAG_RESPIRATORY_RATE_HIGH_PER_MIN'
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.VITAL_FLAG_HEART_RATE_LOW_BPM = '60';
    process.env.VITAL_FLAG_HEART_RATE_HIGH_BPM = '110';
    process.env.VITAL_FLAG_RESPIRATORY_RATE_LOW_PER_MIN = '14';
    process.env.VITAL_FLAG_RESPIRATORY_RATE_HIGH_PER_MIN = '22';
    const result = await recordVitals(input({ heartRate: 55, respiratoryRate: 13 }), user());
    assert.deepEqual(result.abnormalFlags, [
      { measurement: 'pulse', status: 'low' },
      { measurement: 'respiratoryRate', status: 'low' }
    ]);
    assert.equal(result.heartRate, 55);
    assert.equal(result.respiratoryRate, 13);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('server rejects client flags and unsupported fields at the service and HTTP boundaries', async () => {
  await assert.rejects(recordVitals(input({ abnormalFlags: [{ measurement: 'pulse', status: 'normal' }] }), user()), (error) => error.status === 400);
  await assert.rejects(recordVitals(input({ flags: [] }), user()), (error) => error.status === 400);
  const port = server.address().port;
  const body = {
    patient: String(ids.patient), bloodPressure: { systolic: 120, diastolic: 80 }, temperature: 37,
    heartRate: 72, respiratoryRate: 16, weight: 65, oxygenSaturation: 98, idempotencyKey: 'http-vital-key-0001',
    abnormalFlags: [{ measurement: 'pulse', status: 'normal' }]
  };
  const response = await request(port, 'POST', `/api/encounters/${ids.encounter}/vitals`,
    generateToken({ id: String(ids.doctor), role: 'doctor' }), body);
  assert.equal(response.status, 400);
  assert.equal(vitalRecords.size, 0);
});

test('impossible measurements and mismatched/non-finite values are rejected', async () => {
  const impossible = [
    { bloodPressure: { systolic: 80, diastolic: 80 } },
    { bloodPressure: { systolic: 20, diastolic: 10 } },
    { temperature: 46 },
    { temperature: 19 },
    { pulse: 0, heartRate: 0 },
    { pulse: 301, heartRate: 301 },
    { respiratoryRate: 0 },
    { respiratoryRate: 101 },
    { oxygenSaturation: 0 },
    { oxygenSaturation: 101 },
    { weight: 0 },
    { weight: 1001 },
    { height: 4 },
    { height: 351 },
    { temperature: '37' },
    { pulse: Number.NaN }
  ];
  for (const overrides of impossible) {
    await assert.rejects(recordVitals(input(overrides), user()), (error) => error.status === 400);
  }
  assert.equal(vitalRecords.size, 0);
});

test('required and malformed measurements return clear validation errors; respiratory rate remains optional', async () => {
  for (const invalidInput of [
    { ...input(), bloodPressure: undefined },
    { ...input(), temperature: undefined },
    { ...input(), heartRate: undefined },
    { ...input(), weight: undefined },
    input({ bloodPressure: { systolic: 120, diastolic: 80, unit: 'kPa' } }),
    input({ pulse: 72, heartRate: 73 })
  ]) {
    await assert.rejects(recordVitals(invalidInput, user()), (error) => error.status === 400 && typeof error.message === 'string');
  }
  const oldCompatibleRequest = await recordVitals(input(), user());
  assert.equal(oldCompatibleRequest.respiratoryRate, undefined);
  assert.equal(vitalRecords.size, 1);
});

test('only active database doctors with permitted patient access can record or retrieve vitals', async () => {
  currentRole = 'receptionist';
  await assert.rejects(recordVitals(input(), user()), (error) => error.status === 403);
  currentRole = 'doctor';
  currentActive = false;
  await assert.rejects(recordVitals(input(), user()), (error) => error.status === 401);
  currentActive = true;
  patientAccessAllowed = false;
  await assert.rejects(recordVitals(input(), user()), (error) => error.status === 403);

  const port = server.address().port;
  const callsBeforeUnauthorizedHttp = accessCallCount;
  const missingToken = await request(port, 'POST', `/api/encounters/${ids.encounter}/vitals`, null, input());
  assert.equal(missingToken.status, 401);
  const receptionistResponse = await request(port, 'POST', `/api/encounters/${ids.encounter}/vitals`,
    generateToken({ id: String(ids.receptionist), role: 'doctor' }), input());
  assert.equal(receptionistResponse.status, 403);
  assert.equal(accessCallCount, callsBeforeUnauthorizedHttp);
});

test('idempotent recording persists one reading and retrieval is encounter-scoped', async () => {
  const first = await recordVitals(input({ respiratoryRate: 16 }), user());
  const replay = await recordVitals(input({ respiratoryRate: 16 }), user());
  assert.equal(replay.id, first.id);
  assert.equal(replay.replayed, true);
  assert.equal(vitalRecords.size, 1);
  await assert.rejects(recordVitals(input({ respiratoryRate: 18 }), user()), (error) => error.status === 409);

  const secondRequest = input({ encounter: String(ids.otherEncounter), idempotencyKey: 'other-encounter-key' });
  const second = await recordVitals(secondRequest, user());
  const firstEncounterRead = await getEncounterVitals(String(ids.encounter), user());
  assert.equal(firstEncounterRead.length, 1);
  assert.equal(firstEncounterRead[0].id, first.id);
  assert.equal(firstEncounterRead[0].abnormalFlags.length, 0);
  assert.notEqual(second.encounter, firstEncounterRead[0].encounter);
});

test('Vital schema validates physical bounds while preserving optional respiratory rate', async () => {
  const record = new Vital({
    patient: ids.patient, encounter: ids.encounter, recordedBy: ids.doctor,
    bloodPressure: { systolic: 120, diastolic: 80 }, temperature: 37, pulse: 72, weight: 65
  });
  await record.validate();
  const impossible = new Vital({
    patient: ids.patient, encounter: ids.encounter, recordedBy: ids.doctor,
    bloodPressure: { systolic: 80, diastolic: 80 }, temperature: 46, pulse: 0, respiratoryRate: 151,
    weight: 0, oxygenSaturation: 101
  });
  await assert.rejects(impossible.validate(), (error) => error.name === 'ValidationError');
  assert.throws(() => new Vital({ abnormalFlags: [{ measurement: 'pulse', status: 'normal' }] }), /not in schema|strict/i);
});
