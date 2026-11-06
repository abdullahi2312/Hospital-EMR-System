'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const mongoose = require('mongoose');

process.env.JWT_SECRET = 'prescription-allergy-override-test-secret-entropy-123456';
process.env.JWT_EXPIRES_IN = '1d';

const User = require('../models/User');
const Patient = require('../models/Patient');
const Encounter = require('../models/Encounter');
const Medication = require('../models/Medication');
const Allergy = require('../models/Allergy');
const Prescription = require('../models/Prescription');
const AuditLog = require('../models/AuditLog');
const { generateToken } = require('../utils/token');

const ids = {
  doctor: new mongoose.Types.ObjectId(),
  patient: new mongoose.Types.ObjectId(),
  encounter: new mongoose.Types.ObjectId(),
  medication: new mongoose.Types.ObjectId()
};

const patientAccessPath = require.resolve('../services/patient-access.service');
const originalPatientAccessModule = require.cache[patientAccessPath];
const patientAccessModule = new Module(patientAccessPath);
patientAccessModule.filename = patientAccessPath;
patientAccessModule.loaded = true;
patientAccessModule.exports = {
  async authorizePatientRecordAccess(user, patientId, encounterId) {
    return String(user.id) === String(ids.doctor) && String(patientId) === String(ids.patient) && String(encounterId) === String(ids.encounter)
      ? { allowed: true, accessMethod: 'assigned_visit' }
      : { allowed: false, statusCode: 403, message: 'Access denied' };
  }
};
require.cache[patientAccessPath] = patientAccessModule;

const { createPrescription } = require('../services/prescription.service');
const { writeAuditLog } = require('../services/audit-log.service');
const app = require('../app');
const server = http.createServer(app);

const originalMethods = {
  userFindById: User.findById,
  patientFindById: Patient.findById,
  encounterFindById: Encounter.findById,
  medicationFindById: Medication.findById,
  allergyFind: Allergy.find,
  prescriptionFindById: Prescription.findById,
  prescriptionSave: Prescription.prototype.save,
  auditFindOne: AuditLog.findOne,
  auditSave: AuditLog.prototype.save
};

let doctorRole = 'doctor';
let allergies = [];
let medicationActive = true;
let medicationRoute = 'oral';
let auditFailureForOverride = false;
let storedPrescriptions;
let storedAudits;
let capturedBody;

function findQuery(value) {
  return {
    select() { return this; },
    lean: async () => value
  };
}

function resetState() {
  doctorRole = 'doctor';
  allergies = [];
  medicationActive = true;
  medicationRoute = 'oral';
  auditFailureForOverride = false;
  storedPrescriptions = new Map();
  storedAudits = [];
  capturedBody = undefined;
}

User.findById = () => findQuery({ _id: ids.doctor, role: doctorRole, isActive: true });
Encounter.findById = () => ({
  select() { return this; },
  lean: async () => ({ _id: ids.encounter, patient: ids.patient, assignedDoctor: ids.doctor, status: 'in_progress' })
});
Patient.findById = () => ({
  select() { return this; },
  lean: async () => ({ _id: ids.patient, allergies: [], allergyStatus: 'recorded' })
});
Medication.findById = () => ({
  select() { return this; },
  lean: async () => ({
    _id: ids.medication,
    name: 'Penicillin',
    genericName: 'Penicillin',
    brandName: 'Penicillin Brand',
    category: 'Antibiotic',
    route: medicationRoute,
    isActive: medicationActive
  })
});
Allergy.find = () => ({
  select() { return this; },
  lean: async () => allergies.map((allergen) => ({ allergen, allergenGroup: undefined }))
});
Prescription.findById = (id) => ({
  select() { return this; },
  lean: async () => storedPrescriptions.get(String(id)) || null
});
Prescription.prototype.save = async function saveMock() {
  storedPrescriptions.set(String(this._id), this.toObject({ depopulate: true }));
  return this;
};
AuditLog.findOne = (filter) => {
  const match = storedAudits.find((event) => {
    if (filter['allergyOverride.prescription']) {
      return String(event.allergyOverride?.prescription || '') === String(filter['allergyOverride.prescription']);
    }
    return String(event.actor) === String(filter.actor) &&
      event.action === filter.action && event.entityType === filter.entityType &&
      String(event.entityId || '') === String(filter.entityId || '');
  });
  return {
    select() { return this; },
    lean: async () => match || null
  };
};
AuditLog.prototype.save = async function saveAuditMock() {
  if (this.action === 'prescription_allergy_override' && auditFailureForOverride) {
    auditFailureForOverride = false;
    throw new Error('private simulated audit storage failure');
  }
  if (this.action === 'prescription_allergy_override' && storedAudits.some((event) => String(event.allergyOverride?.prescription) === String(this.allergyOverride.prescription))) {
    const error = new Error('duplicate audit event');
    error.code = 11000;
    throw error;
  }
  storedAudits.push(this.toObject({ depopulate: true }));
  return this;
};

const baseInput = () => ({
  encounter: String(ids.encounter),
  medicationId: String(ids.medication),
  dose: '500 mg',
  route: 'oral',
  frequency: 'Twice daily',
  duration: 5,
  quantity: 10,
  idempotencyKey: 'allergy-override-0001'
});
const user = () => ({ id: String(ids.doctor), role: 'doctor' });
const validReason = 'Expected clinical benefit outweighs the assessed potential risk.';

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
  Patient.findById = originalMethods.patientFindById;
  Encounter.findById = originalMethods.encounterFindById;
  Medication.findById = originalMethods.medicationFindById;
  Allergy.find = originalMethods.allergyFind;
  Prescription.findById = originalMethods.prescriptionFindById;
  Prescription.prototype.save = originalMethods.prescriptionSave;
  AuditLog.findOne = originalMethods.auditFindOne;
  AuditLog.prototype.save = originalMethods.auditSave;
  if (originalPatientAccessModule) require.cache[patientAccessPath] = originalPatientAccessModule;
  else delete require.cache[patientAccessPath];
});
test.beforeEach(resetState);

test('possible allergy match blocks normal prescription creation; explicit authorized override is audited safely', async () => {
  allergies = ['Penicillin'];
  await assert.rejects(
    createPrescription(baseInput(), user()),
    (error) => error.status === 409 && error.allergyWarning === true
  );
  assert.equal(storedPrescriptions.size, 0);
  assert.equal(storedAudits.length, 0);

  const port = server.address().port;
  const body = {
    medicationId: String(ids.medication), dose: '500 mg', route: 'oral', frequency: 'Twice daily',
    duration: 5, quantity: 10, idempotencyKey: 'http-override-0001',
    overrideAllergyWarning: true, allergyOverrideReason: validReason,
    doctor: String(new mongoose.Types.ObjectId()), actorId: String(new mongoose.Types.ObjectId())
  };
  const spoofed = await request(port, 'POST', `/api/encounters/${ids.encounter}/prescriptions`, generateToken({ id: String(ids.doctor), role: 'doctor' }), body);
  assert.equal(spoofed.status, 400);

  const cleanBody = { ...body };
  delete cleanBody.doctor;
  delete cleanBody.actorId;
  const response = await request(port, 'POST', `/api/encounters/${ids.encounter}/prescriptions`, generateToken({ id: String(ids.doctor), role: 'doctor' }), cleanBody);
  assert.equal(response.status, 201);
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.medication, String(ids.medication));
  assert.equal(Object.hasOwn(response.body.data, 'allergyOverrideReason'), false);
  assert.equal(JSON.stringify(response.body).includes(validReason), false);

  const overrideEvents = storedAudits.filter((event) => event.action === 'prescription_allergy_override');
  assert.equal(overrideEvents.length, 1);
  assert.equal(String(overrideEvents[0].actor), String(ids.doctor));
  assert.equal(String(overrideEvents[0].entityId), response.body.data.id);
  assert.equal(String(overrideEvents[0].allergyOverride.patient), String(ids.patient));
  assert.equal(String(overrideEvents[0].allergyOverride.prescription), response.body.data.id);
  assert.equal(overrideEvents[0].allergyOverride.reason, validReason);
  assert.equal(overrideEvents[0].details, undefined);
});

test('override reason must be meaningful and trimmed; invalid override inputs are rejected', async () => {
  allergies = ['Penicillin'];
  for (const input of [
    { ...baseInput(), overrideAllergyWarning: true },
    { ...baseInput(), overrideAllergyWarning: true, allergyOverrideReason: 'too short' },
    { ...baseInput(), overrideAllergyWarning: true, allergyOverrideReason: `   ${'x'.repeat(19)}   ` },
    { ...baseInput(), overrideAllergyWarning: 'true', allergyOverrideReason: validReason },
    { ...baseInput(), allergyOverrideReason: validReason }
  ]) {
    await assert.rejects(createPrescription(input, user()), (error) => error.status === 400);
  }
  assert.equal(storedPrescriptions.size, 0);
  assert.equal(storedAudits.length, 0);
});

test('only current active doctors may override and client actor identity is unsupported', async () => {
  allergies = ['Penicillin'];
  const input = { ...baseInput(), overrideAllergyWarning: true, allergyOverrideReason: validReason };
  doctorRole = 'receptionist';
  await assert.rejects(createPrescription(input, user()), (error) => error.status === 403);
  doctorRole = 'doctor';
  await assert.rejects(createPrescription({ ...input, actorId: String(ids.doctor) }, user()), (error) => error.status === 400);
  assert.equal(storedPrescriptions.size, 0);
});

test('unrelated prescription validation remains blocking and no-match prescriptions need no override', async () => {
  allergies = ['Penicillin'];
  await assert.rejects(
    createPrescription({ ...baseInput(), route: 'injection', overrideAllergyWarning: true, allergyOverrideReason: validReason }, user()),
    (error) => error.status === 400 && /route does not match/.test(error.message)
  );
  assert.equal(storedPrescriptions.size, 0);

  allergies = [];
  const prescription = await createPrescription(baseInput(), user());
  assert.ok(prescription.id);
  assert.equal(prescription.status, 'pending');
  assert.equal(prescription.replayed, undefined);
  assert.equal(storedAudits.some((event) => event.action === 'prescription_allergy_override'), false);

  await assert.rejects(
    createPrescription({ ...baseInput(), idempotencyKey: 'unused-override-01', overrideAllergyWarning: true, allergyOverrideReason: validReason }, user()),
    (error) => error.status === 409 && /no current allergy warning/.test(error.message)
  );
});

test('same-key override retry reuses the prescription and one audit event; changed reason conflicts', async () => {
  allergies = ['Penicillin'];
  const input = { ...baseInput(), overrideAllergyWarning: true, allergyOverrideReason: validReason };
  const first = await createPrescription(input, user());
  const retry = await createPrescription(input, user());
  assert.equal(retry.id, first.id);
  assert.equal(retry.replayed, true);
  assert.equal(storedPrescriptions.size, 1);
  assert.equal(storedAudits.filter((event) => event.action === 'prescription_allergy_override').length, 1);
  await assert.rejects(
    createPrescription({ ...input, allergyOverrideReason: 'A different reason of sufficient meaningful length.' }, user()),
    (error) => error.status === 409
  );
});

test('override audit failure is explicit and same-key retry repairs it without duplicate prescription', async () => {
  allergies = ['Penicillin'];
  auditFailureForOverride = true;
  const input = { ...baseInput(), overrideAllergyWarning: true, allergyOverrideReason: validReason };
  await assert.rejects(
    createPrescription(input, user()),
    (error) => error.status === 503 && error.partialSuccess === true && Boolean(error.prescriptionId)
  );
  assert.equal(storedPrescriptions.size, 1);
  assert.equal(storedAudits.filter((event) => event.action === 'prescription_allergy_override').length, 0);

  const retry = await createPrescription(input, user());
  assert.equal(retry.replayed, true);
  assert.equal(storedPrescriptions.size, 1);
  assert.equal(storedAudits.filter((event) => event.action === 'prescription_allergy_override').length, 1);
});

test('concurrent duplicate override audit writes recover the one event protected by its unique prescription key', async () => {
  allergies = ['Penicillin'];
  const prescription = await createPrescription({
    ...baseInput(), overrideAllergyWarning: true, allergyOverrideReason: validReason
  }, user());
  const before = storedAudits.length;
  const overrideAudit = storedAudits.find((event) => event.action === 'prescription_allergy_override');
  const retryInput = {
    actorId: ids.doctor,
    action: 'prescription_allergy_override',
    entityType: 'Prescription',
    entityId: new mongoose.Types.ObjectId(prescription.id),
    allergyOverride: {
      patientId: ids.patient,
      prescriptionId: new mongoose.Types.ObjectId(prescription.id),
      reason: validReason
    }
  };
  assert.ok(overrideAudit);
  const recovered = await Promise.all([writeAuditLog(retryInput), writeAuditLog(retryInput)]);
  assert.equal(storedAudits.length, before);
  assert.ok(recovered.every((result) => result.deduplicated === true));
  assert.equal(recovered[0].id, recovered[1].id);
});

test('AuditLog keeps override data private and deduplicates by prescription without weakening details validation', async () => {
  const prescriptionId = new mongoose.Types.ObjectId();
  const record = new AuditLog({
    actor: ids.doctor,
    action: 'prescription_allergy_override',
    entityType: 'Prescription',
    entityId: prescriptionId,
    allergyOverride: { patient: ids.patient, prescription: prescriptionId, reason: validReason }
  });
  await record.validate();
  assert.equal(AuditLog.schema.path('allergyOverride').options.select, false);
  assert.equal(AuditLog.schema.path('allergyOverride').options.immutable, true);
  const index = AuditLog.schema.indexes().find(([keys]) => keys['allergyOverride.prescription'] === 1);
  assert.equal(index[1].unique, true);
  assert.deepEqual(index[1].partialFilterExpression, { 'allergyOverride.prescription': { $type: 'objectId' } });
  await assert.rejects(new AuditLog({
    actor: ids.doctor, action: 'prescription_allergy_override', entityType: 'Prescription', entityId: prescriptionId,
    details: { allergyOverrideReason: validReason }
  }).validate());
  await assert.rejects(new AuditLog({
    actor: ids.doctor, action: 'prescription_allergy_override', entityType: 'Prescription', entityId: prescriptionId,
    allergyOverride: { patient: ids.patient, prescription: prescriptionId, reason: 'short' }
  }).validate());
});
