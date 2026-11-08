'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

process.env.PATIENT_IDENTITY_HMAC_SECRET = 'patient-identity-test-secret-with-at-least-32-bytes';

const Patient = require('../models/Patient');
const actualOperationModel = require('../models/PatientRegistrationOperation');
const User = require('../models/User');
const registrarId = new mongoose.Types.ObjectId();
const patients = new Map();
const operations = new Map();
const auditEvents = [];
let sequence = 0;
let failAudit = false;
let failOperationSave = false;
let losePatientSaveAcknowledgement = false;
let generatedKey = 0;

const counterCollection = {
  async findOne() {
    return sequence > 0 ? { _id: 'patient_mrn_sequence', sequence } : null;
  },
  async insertOne(document) {
    if (sequence > 0) {
      const error = new Error('duplicate sequence');
      error.code = 11000;
      throw error;
    }
    sequence = document.sequence;
    return { acknowledged: true };
  },
  async findOneAndUpdate() {
    sequence += 1;
    return { sequence };
  }
};
mongoose.connection.db = { collection: () => counterCollection };

function makeQuery(value) {
  return {
    sort() { return this; },
    select() { return this; },
    lean: async () => value
  };
}

function cloneOperation(operation) {
  return operation ? { ...operation, leaseUntil: operation.leaseUntil ? new Date(operation.leaseUntil) : operation.leaseUntil } : null;
}

class MockRegistrationOperation {
  constructor(values) {
    Object.assign(this, values);
    this._id = new mongoose.Types.ObjectId();
  }

  async save() {
    if (failOperationSave) throw new Error('simulated registration-operation database failure');
    const key = `${this.actor}:${this.idempotencyKeyHash}`;
    if (operations.has(key)) {
      const error = new Error('duplicate operation key');
      error.code = 11000;
      throw error;
    }
    operations.set(key, { ...this });
    return this;
  }

  toObject() { return { ...this }; }

  static findOne(filter) {
    return makeQuery(cloneOperation(operations.get(`${filter.actor}:${filter.idempotencyKeyHash}`)));
  }

  static findOneAndUpdate(filter, update) {
    const operation = [...operations.values()].find((item) => String(item._id) === String(filter._id));
    if (!operation) return makeQuery(null);
    const now = new Date();
    const canClaim = operation.status === 'pending' ||
      (operation.status === 'creating' && operation.leaseUntil && operation.leaseUntil <= now);
    if (!canClaim) return makeQuery(null);
    Object.assign(operation, update.$set);
    return makeQuery(cloneOperation(operation));
  }

  static async updateOne(filter, update) {
    const operation = [...operations.values()].find((item) => String(item._id) === String(filter._id));
    if (!operation) return { matchedCount: 0 };
    for (const [field, expected] of Object.entries(filter)) {
      if (field === '_id') continue;
      if (expected && typeof expected === 'object' && '$in' in expected) {
        if (!expected.$in.includes(operation[field])) return { matchedCount: 0 };
      } else if (operation[field] !== expected) return { matchedCount: 0 };
    }
    Object.assign(operation, update.$set || {});
    for (const field of Object.keys(update.$unset || {})) delete operation[field];
    return { matchedCount: 1 };
  }
}

const operationPath = require.resolve('../models/PatientRegistrationOperation');
const operationModule = new (require('node:module'))(operationPath);
operationModule.filename = operationPath;
operationModule.loaded = true;
operationModule.exports = MockRegistrationOperation;
require.cache[operationPath] = operationModule;

function sameName(patient, first, father, grandfather) {
  const normalize = (value) => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
  return normalize(patient.firstName) === normalize(first) &&
    normalize(patient.fatherName) === normalize(father) &&
    normalize(patient.grandfatherName) === normalize(grandfather);
}

Patient.find = (filter = {}) => {
  const rows = [...patients.values()].filter((patient) => {
    if (filter.dateOfBirth) {
      return patient.dateOfBirth && patient.dateOfBirth >= filter.dateOfBirth.$gte && patient.dateOfBirth < filter.dateOfBirth.$lt;
    }
    if (filter.estimatedAge !== undefined) {
      return patient.estimatedAge === filter.estimatedAge && patient.sex === filter.sex && !patient.dateOfBirth;
    }
    if (filter.phone) return Boolean(patient.phone);
    return true;
  }).map((patient) => patient.toObject({ getters: false, virtuals: false }));
  return makeQuery(rows);
};
Patient.findOne = () => makeQuery(null);
Patient.findById = (id) => makeQuery(patients.get(String(id))
  ? patients.get(String(id)).toObject({ getters: false, virtuals: false })
  : null);
Patient.prototype.save = async function saveWithMockedUniqueIndexes() {
  await this.validate();
  const identityFields = [
    ['identityNameDobKey', 'unique_patient_normalized_name_dob'],
    ['identityNameEstimatedAgeKey', 'unique_patient_normalized_name_estimated_age'],
    ['identityPhoneKey', 'unique_patient_normalized_phone']
  ];
  for (const [field, indexName] of identityFields) {
    if (this[field] && [...patients.values()].some((patient) => patient[field] === this[field])) {
      const error = new Error(`duplicate key ${indexName}`);
      error.code = 11000;
      error.keyPattern = { [field]: 1 };
      throw error;
    }
  }
  if ([...patients.values()].some((patient) => patient.mrn === this.mrn)) {
    const error = new Error('duplicate MRN');
    error.code = 11000;
    error.keyPattern = { mrn: 1 };
    throw error;
  }
  this.createdAt ||= new Date();
  this.updatedAt ||= this.createdAt;
  patients.set(String(this._id), this);
  if (losePatientSaveAcknowledgement) {
    losePatientSaveAcknowledgement = false;
    throw new Error('simulated lost acknowledgement after patient save');
  }
  return this;
};

User.findById = () => ({
  select() { return this; },
  lean: async () => ({ _id: registrarId, role: 'receptionist', isActive: true })
});

const auditPath = require.resolve('../services/audit-log.service');
const auditModule = new (require('node:module'))(auditPath);
auditModule.filename = auditPath;
auditModule.loaded = true;
auditModule.exports = {
  async writeAuditLog(event) {
    if (failAudit) throw new Error('simulated audit failure');
    const existing = auditEvents.find((audit) => audit.patientRegistrationDeduplicationKey === event.patientRegistrationDeduplicationKey);
    if (existing) return { id: String(existing.entityId), deduplicated: true };
    auditEvents.push({ ...event });
  }
};
require.cache[auditPath] = auditModule;

const { registerPatient } = require('../services/patient.service');

test.beforeEach(() => {
  patients.clear();
  operations.clear();
  auditEvents.length = 0;
  sequence = 0;
  failAudit = false;
  failOperationSave = false;
  losePatientSaveAcknowledgement = false;
  generatedKey = 0;
});

function patientInput(overrides = {}) {
  return {
    firstName: 'Ayaan',
    fatherName: 'Ali',
    grandfatherName: 'Hassan',
    sex: 'female',
    dateOfBirth: '1990-03-10',
    ...overrides
  };
}

const registrar = { id: String(registrarId), role: 'receptionist' };

function register(input, key, actor = registrar) {
  generatedKey += 1;
  const idempotencyKey = key || `patient-register-${String(generatedKey).padStart(4, '0')}`;
  return registerPatient({ ...input, idempotencyKey }, actor);
}

test('same normalized full name and DOB is rejected', async () => {
  const result = await register(patientInput(), 'name-dob-key-0001');
  assert.equal(result.mrn, 'MRN-000001');
  await assert.rejects(
    register(patientInput({ firstName: '  AYAAN ', fatherName: ' ali', grandfatherName: 'HASSAN  ' }), 'name-dob-key-0002'),
    { status: 409 }
  );
  assert.equal(patients.size, 1);
});

test('same normalized phone is rejected even when names and DOB differ', async () => {
  await register(patientInput({ phone: '+252 61-123-4567' }), 'same-phone-key-0001');
  await assert.rejects(
    register(patientInput({
      firstName: 'Hodan', fatherName: 'Omar', grandfatherName: 'Nur',
      dateOfBirth: '1985-01-01', phone: '00252 (61) 123 4567'
    }), 'same-phone-key-0002'),
    { status: 409 }
  );
  assert.equal(patients.size, 1);
});

test('different patients and missing phone numbers remain supported', async () => {
  const first = await register(patientInput({ phone: undefined }), 'missing-phone-key-0001');
  const second = await register(patientInput({
    firstName: 'Hodan', fatherName: 'Omar', grandfatherName: 'Nur',
    dateOfBirth: '1985-01-01', phone: undefined
  }), 'missing-phone-key-0002');
  assert.equal(first.mrn, 'MRN-000001');
  assert.equal(second.mrn, 'MRN-000002');
  assert.equal(patients.size, 2);
});

test('estimated-age identity is protected while preserving the schema alternative to DOB', async () => {
  const registration = patientInput({ dateOfBirth: undefined, estimatedAge: 34, phone: undefined });
  await register(registration, 'estimated-age-key-0001');
  await assert.rejects(register(registration, 'estimated-age-key-0002'), { status: 409 });

  const differentSex = await register({ ...registration, sex: 'male' }, 'estimated-age-key-0003');
  assert.equal(differentSex.mrn, 'MRN-000002');
  assert.equal(patients.size, 2);
});

test('concurrent registrations bypassing the read check are stopped by simulated unique indexes', async () => {
  const results = await Promise.allSettled([
    register(patientInput(), 'concurrent-identity-0001'),
    register(patientInput({ firstName: ' AYAAN ', fatherName: 'ALI', grandfatherName: 'HASSAN' }), 'concurrent-identity-0002')
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejection = results.find((result) => result.status === 'rejected');
  assert.equal(rejection.reason.status, 409);
  assert.equal(patients.size, 1);
  assert.equal(new Set([...patients.values()].map((patient) => patient.mrn)).size, 1);
});

test('same actor, key, and canonical input replays the original patient without allocating another MRN', async () => {
  const input = patientInput({ phone: '+252 61 234 5678' });
  const first = await register(input, 'registration-replay-key-0001');
  const replay = await register(input, 'registration-replay-key-0001');
  assert.equal(replay.id, first.id);
  assert.equal(replay.mrn, first.mrn);
  assert.equal(patients.size, 1);
  assert.equal(sequence, 1);
  assert.equal(operations.size, 1);
  const operation = [...operations.values()][0];
  assert.equal(Object.hasOwn(operation, 'firstName'), false);
  assert.equal(Object.hasOwn(operation, 'phone'), false);
  assert.equal(Object.hasOwn(operation, 'dateOfBirth'), false);
  assert.equal(operation.patient.toString(), first.id);
});

test('same actor and key with different normalized registration input conflicts', async () => {
  await register(patientInput(), 'registration-conflict-key-0001');
  await assert.rejects(
    register(patientInput({ district: 'Hargeisa' }), 'registration-conflict-key-0001'),
    { status: 409 }
  );
  assert.equal(patients.size, 1);
  assert.equal(sequence, 1);
});

test('operation-store database failure is retryable with the same key and creates only one patient and MRN', async () => {
  const key = 'registration-database-retry-key-0001';
  failOperationSave = true;
  await assert.rejects(register(patientInput(), key), { status: 503 });
  assert.equal(patients.size, 0);
  assert.equal(operations.size, 0);
  assert.equal(sequence, 0);
  assert.equal(auditEvents.length, 0);

  failOperationSave = false;
  const recovered = await register(patientInput(), key);
  assert.match(recovered.mrn, /^MRN-\d{6}$/);
  assert.equal(patients.size, 1);
  assert.equal(operations.size, 1);
  assert.equal(sequence, 1);
  assert.equal(auditEvents.length, 1);
});

test('retry with the same key recovers a patient saved before its response was lost', async () => {
  const key = 'registration-save-ack-lost-0001';
  losePatientSaveAcknowledgement = true;
  await assert.rejects(register(patientInput(), key), (error) => error.status === 503);
  const [originalPatient] = [...patients.values()];
  assert.ok(originalPatient);
  assert.equal(patients.size, 1);
  assert.equal(operations.size, 1);
  assert.equal(sequence, 1);
  assert.equal(auditEvents.length, 0);

  const recovered = await register(patientInput(), key);
  assert.equal(recovered.id, String(originalPatient._id));
  assert.equal(recovered.mrn, originalPatient.mrn);
  assert.equal(patients.size, 1);
  assert.equal(operations.size, 1);
  assert.equal(sequence, 1);
  assert.equal(auditEvents.length, 1);
});

test('registration idempotency key is required and strictly validated', async () => {
  await assert.rejects(registerPatient(patientInput(), registrar), { status: 400 });
  await assert.rejects(register(patientInput(), 'short'), { status: 400 });
  await assert.rejects(register(patientInput(), 'not a valid key'), { status: 400 });
  assert.equal(patients.size, 0);
  assert.equal(operations.size, 0);
  assert.equal(sequence, 0);
});

test('concurrent same-key submissions create one patient, one MRN, and one audit event', async () => {
  const key = 'registration-concurrent-key-0001';
  const results = await Promise.all([
    register(patientInput(), key),
    register(patientInput(), key)
  ]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(results[0].mrn, results[1].mrn);
  assert.equal(patients.size, 1);
  assert.equal(sequence, 1);
  assert.equal(auditEvents.length, 1);
});

test('audit-failure retry recovers audit without creating a second patient or incrementing MRN', async () => {
  const key = 'audit-recovery-key-0001';
  failAudit = true;
  await assert.rejects(register(patientInput(), key), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.partialSuccess, true);
    return true;
  });
  assert.equal(patients.size, 1);
  assert.equal(sequence, 1);

  failAudit = false;
  const recovered = await register(patientInput(), key);
  assert.equal(recovered.mrn, 'MRN-000001');
  assert.equal(recovered.id, [...patients.keys()][0]);
  assert.equal(patients.size, 1);
  assert.equal(sequence, 1);
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0].action, 'patient_registered');
  assert.equal(String(auditEvents[0].entityId), recovered.id);
  assert.equal(Object.hasOwn(auditEvents[0], 'details'), false);
});

test('concurrent retries recover one missing audit event using durable audit deduplication', async () => {
  const key = 'registration-audit-race-key-0001';
  failAudit = true;
  await assert.rejects(register(patientInput(), key), { partialSuccess: true });
  failAudit = false;
  const results = await Promise.all([
    register(patientInput(), key),
    register(patientInput(), key)
  ]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(patients.size, 1);
  assert.equal(sequence, 1);
  assert.equal(auditEvents.length, 1);
});

test('Patient declares private partial unique identity indexes and HMACs normalized values', async () => {
  const indexes = Patient.schema.indexes();
  for (const field of ['identityNameDobKey', 'identityNameEstimatedAgeKey', 'identityPhoneKey']) {
    const index = indexes.find(([keys]) => keys[field] === 1);
    assert.equal(index?.[1].unique, true);
    assert.ok(index?.[1].partialFilterExpression);
    assert.equal(Patient.schema.path(field).options.select, false);
  }

  const first = new Patient({ ...patientInput(), mrn: 'MRN-111111', registeredBy: registrarId });
  const second = new Patient({ ...patientInput({ firstName: ' AYAAN ', fatherName: 'ALI', grandfatherName: 'HASSAN' }), mrn: 'MRN-111112', registeredBy: registrarId });
  await first.validate();
  await second.validate();
  assert.equal(first.identityNameDobKey, second.identityNameDobKey);
  assert.match(first.identityNameDobKey, /^[a-f0-9]{64}$/);

  const operationIndexes = actualOperationModel.schema.indexes();
  assert.ok(operationIndexes.some(([keys, options]) => keys.actor === 1 && keys.idempotencyKeyHash === 1 && options.unique));
  assert.equal(actualOperationModel.schema.path('inputFingerprint').options.select, false);
});

test('missing HMAC configuration fails safely before a patient is saved', async () => {
  const configuredSecret = process.env.PATIENT_IDENTITY_HMAC_SECRET;
  delete process.env.PATIENT_IDENTITY_HMAC_SECRET;
  try {
    await assert.rejects(register(patientInput(), 'missing-secret-key-0001'), (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, 'PATIENT_IDEMPOTENCY_NOT_CONFIGURED');
      assert.equal(error.retrySameKey, true);
      assert.match(error.message, /idempotency protection is not configured/i);
      return true;
    });
    assert.equal(patients.size, 0);
    assert.equal(operations.size, 0);
    assert.equal(sequence, 0);
    assert.equal(auditEvents.length, 0);
  } finally {
    process.env.PATIENT_IDENTITY_HMAC_SECRET = configuredSecret;
  }
});
