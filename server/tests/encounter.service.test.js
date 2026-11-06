const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const model = (name) => require(`../models/${name}`);
const User = model('User');
const Patient = model('Patient');
const Department = model('Department');
const Encounter = model('Encounter');
const AuditLog = model('AuditLog');
const AccessLog = model('AccessLog');

const accessModulePath = require.resolve('../services/patient-access.service');
const auditModulePath = require.resolve('../services/audit-log.service');
require.cache[accessModulePath] = {
  id: accessModulePath,
  filename: accessModulePath,
  loaded: true,
  exports: {
    authorizePatientRecordAccess: async (user, patientId, encounterId) => {
      accessDecisions.push({ user, patientId, encounterId });
      const allowed = user.role === 'doctor' || String(user.patient || '') === String(patientId);
      return { allowed, statusCode: allowed ? 200 : 403, message: 'Denied' };
    }
  }
};

let auditEvents = [];
let failNextAudit = false;
let accessDecisions = [];
require.cache[auditModulePath] = {
  id: auditModulePath,
  filename: auditModulePath,
  loaded: true,
  exports: {
    writeAuditLog: async (event) => {
      if (failNextAudit) {
        failNextAudit = false;
        throw new Error('mock audit failure');
      }
      auditEvents.push(event);
      return { id: new mongoose.Types.ObjectId().toString() };
    }
  }
};

const { createEncounter, assignEncounterDoctor, getEncounterDetails, listEncounters, closeEncounter } = require('../services/encounter.service');

const ids = {
  admin: new mongoose.Types.ObjectId(),
  receptionist: new mongoose.Types.ObjectId(),
  doctor: new mongoose.Types.ObjectId(),
  otherDoctor: new mongoose.Types.ObjectId(),
  patientUser: new mongoose.Types.ObjectId(),
  unlinkedPatientUser: new mongoose.Types.ObjectId(),
  technician: new mongoose.Types.ObjectId(),
  patient: new mongoose.Types.ObjectId(),
  otherPatient: new mongoose.Types.ObjectId(),
  department: new mongoose.Types.ObjectId()
};

let users;
let patients;
let encounters;
let counter;
let accessLogEvents;

function plain(value) {
  return value && typeof value.toObject === 'function' ? value.toObject() : value;
}

function query(value) {
  return {
    select() { return this; },
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    lean() { return Promise.resolve(value); }
  };
}

function sameId(left, right) {
  return left != null && right != null && String(left) === String(right);
}

function matches(encounter, filter) {
  if (filter._id && !sameId(encounter._id, filter._id)) return false;
  if (filter.patient && !sameId(encounter.patient, filter.patient)) return false;
  if (filter.assignedDoctor && !sameId(encounter.assignedDoctor, filter.assignedDoctor)) return false;
  if (filter.status && Array.isArray(filter.status.$in) && !filter.status.$in.includes(encounter.status)) return false;
  if (filter.assignedDoctor === null && encounter.assignedDoctor != null) return false;
  if (filter.$or && !filter.$or.some((condition) => (
    condition.assignedDoctor === null ? encounter.assignedDoctor == null :
      condition.assignedDoctor?.$exists === false ? encounter.assignedDoctor === undefined : false
  ))) return false;
  return true;
}

function reset() {
  users = new Map([
    [String(ids.admin), { _id: ids.admin, role: 'admin', isActive: true }],
    [String(ids.receptionist), { _id: ids.receptionist, role: 'receptionist', isActive: true }],
    [String(ids.doctor), { _id: ids.doctor, role: 'doctor', isActive: true }],
    [String(ids.otherDoctor), { _id: ids.otherDoctor, role: 'doctor', isActive: true }],
    [String(ids.patientUser), { _id: ids.patientUser, role: 'patient', patient: ids.patient, isActive: true }],
    [String(ids.unlinkedPatientUser), { _id: ids.unlinkedPatientUser, role: 'patient', isActive: true }],
    [String(ids.technician), { _id: ids.technician, role: 'lab_technician', isActive: true }]
  ]);
  patients = new Set([String(ids.patient), String(ids.otherPatient)]);
  encounters = new Map();
  counter = 0;
  auditEvents = [];
  failNextAudit = false;
  accessDecisions = [];
  accessLogEvents = [];
  AccessLog.create = async (event) => { accessLogEvents.push(event); return event; };

  User.findById = (id) => query(users.get(String(id)) || null);
  Patient.findById = (id) => query(patients.has(String(id)) ? { _id: new mongoose.Types.ObjectId(String(id)) } : null);
  Department.findOne = () => query({ _id: ids.department, name: 'Outpatient', code: 'OPD' });

  Encounter.findOne = () => query(null);
  Encounter.findById = (id) => query(encounters.get(String(id)) || null);
  Encounter.prototype.save = async function save() {
    const stored = plain(this);
    stored.createdAt ||= new Date();
    stored.updatedAt ||= stored.createdAt;
    encounters.set(String(stored._id), stored);
    return this;
  };
  Encounter.findOneAndUpdate = (filter, update) => {
    const current = encounters.get(String(filter._id));
    if (!current || !matches(current, filter)) return query(null);
    Object.assign(current, update.$set);
    current.updatedAt = new Date();
    return query({ ...current });
  };
  Encounter.find = (filter) => {
    const result = [...encounters.values()]
      .filter((item) => matches(item, filter))
      .sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt));
    return {
      select() { return this; },
      sort() { return this; },
      skip(count) { this.offset = count; return this; },
      limit(count) { this.max = count; return this; },
      lean() { return Promise.resolve(result.slice(this.offset || 0, (this.offset || 0) + (this.max || result.length))); }
    };
  };
  Encounter.countDocuments = async (filter) => [...encounters.values()].filter((item) => matches(item, filter)).length;

  AuditLog.findOne = (filter) => {
    const found = auditEvents.find((event) => sameId(event.actorId, filter.actor) &&
      event.action === filter.action && event.entityType === filter.entityType &&
      sameId(event.entityId, filter.entityId) &&
      (!filter['details.operationKey'] || event.details?.operationKey === filter['details.operationKey']));
    return query(found ? { _id: new mongoose.Types.ObjectId() } : null);
  };

  mongoose.connection.db = {
    collection() {
      return {
        async findOne() { return counter ? { _id: 'encounter_visit_sequence', sequence: counter } : null; },
        async insertOne(document) { counter = document.sequence; },
        async findOneAndUpdate(_filter, _update) {
          counter += 1;
          return { sequence: counter };
        }
      };
    }
  };

}

function actor(id) { return { id: String(id), role: 'spoofed-role' }; }

test('encounter management service enforces permissions, lifecycle, access, retry, and pagination with mocked persistence', async (t) => {
  reset();

  await t.test('receptionist/admin create safely and creation retry repairs an audit failure', async () => {
    reset();
    const input = {
      patient: String(ids.patient), department: 'OPD', visitType: 'outpatient',
      chiefComplaint: 'Cough', idempotencyKey: 'new-visit-0001'
    };
    failNextAudit = true;
    await assert.rejects(createEncounter(input, actor(ids.receptionist)), (error) => (
      error.status === 503 && error.partialSuccess === true && Boolean(error.encounterId)
    ));
    assert.equal(encounters.size, 1);

    const created = await createEncounter(input, actor(ids.receptionist));
    assert.equal(created.replayed, true);
    assert.equal(created.visitNumber, 'VISIT-000001');
    assert.equal(created.status, 'open');
    assert.equal(created.assignedDoctor, undefined);
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].action, 'encounter_created');
    assert.equal(auditEvents[0].details, undefined);

    await assert.rejects(createEncounter({ ...input, status: 'closed' }, actor(ids.admin)), /unsupported or server-managed/);
    await assert.rejects(createEncounter({ ...input, idempotencyKey: undefined }, actor(ids.admin)), /idempotencyKey/);
  });

  await t.test('creation rejects missing patient, inactive actor, unsupported role, and inactive department', async () => {
    reset();
    const base = { patient: String(ids.patient), department: 'OPD', visitType: 'emergency', idempotencyKey: 'valid-key-0001' };
    await assert.rejects(createEncounter({ ...base, patient: undefined }, actor(ids.receptionist)), /patient ID is required/);
    await assert.rejects(createEncounter({ ...base, patient: 'not-an-object-id' }, actor(ids.receptionist)), /patient ID is required/);
    await assert.rejects(createEncounter({ ...base, patient: String(ids.otherDoctor) }, actor(ids.receptionist)), (error) => error.status === 404);
    await assert.rejects(createEncounter(base, actor(new mongoose.Types.ObjectId())), (error) => error.status === 401);
    await assert.rejects(createEncounter(base, actor(ids.doctor)), (error) => error.status === 403);
    await assert.rejects(createEncounter(base, actor(ids.technician)), (error) => error.status === 403);
    users.set(String(ids.receptionist), { _id: ids.receptionist, role: 'receptionist', isActive: false });
    await assert.rejects(createEncounter(base, actor(ids.receptionist)), (error) => error.status === 401);
    Department.findOne = () => query(null);
    await assert.rejects(createEncounter({ ...base, idempotencyKey: 'valid-key-0002' }, actor(ids.admin)), (error) => error.status === 404);
  });

  await t.test('only admin assigns an active doctor; reassignment and audit retry are safe', async () => {
    reset();
    const created = await createEncounter({
      patient: String(ids.patient), department: 'OPD', visitType: 'inpatient', idempotencyKey: 'assignment-create-1'
    }, actor(ids.receptionist));
    await assert.rejects(assignEncounterDoctor({ encounterId: created.id, doctorId: String(ids.doctor), idempotencyKey: 'assign-key-001' }, actor(ids.receptionist)), (error) => error.status === 403);

    const inactiveId = new mongoose.Types.ObjectId();
    users.set(String(inactiveId), { _id: inactiveId, role: 'doctor', isActive: false });
    await assert.rejects(assignEncounterDoctor({ encounterId: created.id, doctorId: String(inactiveId), idempotencyKey: 'assign-key-002' }, actor(ids.admin)), (error) => error.status === 400);
    await assert.rejects(assignEncounterDoctor({ encounterId: created.id, doctorId: String(ids.technician), idempotencyKey: 'assign-key-002b' }, actor(ids.admin)), (error) => error.status === 400);
    await assert.rejects(assignEncounterDoctor({ encounterId: created.id, doctorId: String(new mongoose.Types.ObjectId()), idempotencyKey: 'assign-key-002c' }, actor(ids.admin)), (error) => error.status === 400);

    failNextAudit = true;
    await assert.rejects(assignEncounterDoctor({ encounterId: created.id, doctorId: String(ids.doctor), idempotencyKey: 'assign-key-003' }, actor(ids.admin)), (error) => error.status === 503 && error.partialSuccess);
    assert.equal(String(encounters.get(created.id).assignedDoctor), String(ids.doctor));
    const assigned = await assignEncounterDoctor({ encounterId: created.id, doctorId: String(ids.doctor), idempotencyKey: 'assign-key-003' }, actor(ids.admin));
    assert.equal(assigned.replayed, true);
    assert.equal(auditEvents.filter((entry) => entry.action === 'encounter_doctor_assigned').length, 1);

    const reassigned = await assignEncounterDoctor({ encounterId: created.id, doctorId: String(ids.otherDoctor), idempotencyKey: 'assign-key-004' }, actor(ids.admin));
    assert.equal(reassigned.assignedDoctor, String(ids.otherDoctor));
  });

  await t.test('patients see only their own encounter and doctors only assigned encounters through access policy', async () => {
    reset();
    const first = await createEncounter({ patient: String(ids.patient), department: 'OPD', visitType: 'outpatient', idempotencyKey: 'read-create-001' }, actor(ids.admin));
    const second = await createEncounter({ patient: String(ids.otherPatient), department: 'OPD', visitType: 'outpatient', idempotencyKey: 'read-create-002' }, actor(ids.admin));
    await assignEncounterDoctor({ encounterId: first.id, doctorId: String(ids.doctor), idempotencyKey: 'read-assign-001' }, actor(ids.admin));
    await assignEncounterDoctor({ encounterId: second.id, doctorId: String(ids.otherDoctor), idempotencyKey: 'read-assign-002' }, actor(ids.admin));

    assert.equal((await getEncounterDetails(first.id, actor(ids.doctor))).id, first.id);
    await assert.rejects(getEncounterDetails(second.id, actor(ids.doctor)), (error) => error.status === 403);
    assert.equal((await getEncounterDetails(first.id, actor(ids.patientUser))).id, first.id);
    await assert.rejects(getEncounterDetails(second.id, actor(ids.patientUser)), (error) => error.status === 404);
    await assert.rejects(getEncounterDetails(first.id, actor(ids.receptionist)), (error) => error.status === 403);

    const doctorList = await listEncounters({ page: '1', limit: '20' }, actor(ids.doctor));
    assert.deepEqual(doctorList.encounters.map((item) => item.id), [first.id]);
    const patientList = await listEncounters({}, actor(ids.patientUser));
    assert.deepEqual(patientList.encounters.map((item) => item.patient), [String(ids.patient)]);
    assert.equal(patientList.pagination.page, 1);
    assert.equal(patientList.pagination.limit, 20);
    await assert.rejects(listEncounters({ limit: '101' }, actor(ids.doctor)), (error) => error.status === 400);
    await assert.rejects(listEncounters({ patient: String(ids.otherPatient) }, actor(ids.patientUser)), /unsupported or server-managed/);
    await assert.rejects(listEncounters({}, actor(ids.unlinkedPatientUser)), (error) => error.status === 403);
    assert.ok(accessDecisions.length >= 4);
    assert.equal(accessLogEvents.length, 2);
    assert.ok(accessLogEvents.every((entry) => entry.action === 'denied_access' && entry.accessMethod === 'denied'));
  });

  await t.test('only the assigned doctor closes once, and close retry does not duplicate audit', async () => {
    reset();
    const created = await createEncounter({ patient: String(ids.patient), department: 'OPD', visitType: 'emergency', idempotencyKey: 'close-create-01' }, actor(ids.admin));
    await assignEncounterDoctor({ encounterId: created.id, doctorId: String(ids.doctor), idempotencyKey: 'close-assign-01' }, actor(ids.admin));
    await assert.rejects(closeEncounter({ encounterId: created.id }, actor(ids.otherDoctor)), (error) => error.status === 403);

    failNextAudit = true;
    await assert.rejects(closeEncounter({ encounterId: created.id }, actor(ids.doctor)), (error) => error.status === 503 && error.partialSuccess);
    const saved = encounters.get(created.id);
    assert.equal(saved.status, 'closed');
    assert.ok(saved.closedAt instanceof Date);
    const closed = await closeEncounter({ encounterId: created.id }, actor(ids.doctor));
    assert.equal(closed.replayed, true);
    assert.equal(auditEvents.filter((entry) => entry.action === 'encounter_closed').length, 1);
    await assert.rejects(closeEncounter({ encounterId: created.id, closedBy: String(ids.doctor) }, actor(ids.doctor)), /unsupported or server-managed/);
  });

  await t.test('a compare-and-set assignment that loses a simulated race returns conflict', async () => {
    reset();
    const created = await createEncounter({ patient: String(ids.patient), department: 'OPD', visitType: 'outpatient', idempotencyKey: 'race-create-0001' }, actor(ids.admin));
    const originalUpdate = Encounter.findOneAndUpdate;
    Encounter.findOneAndUpdate = () => query(null); // Simulates another writer changing the encounter after the read.
    await assert.rejects(
      assignEncounterDoctor({ encounterId: created.id, doctorId: String(ids.doctor), idempotencyKey: 'race-assignment-01' }, actor(ids.admin)),
      (error) => error.status === 409
    );
    Encounter.findOneAndUpdate = originalUpdate;
    assert.equal(encounters.get(created.id).assignedDoctor, undefined);
  });
});
