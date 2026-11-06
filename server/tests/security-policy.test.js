'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const User = require('../models/User');
const Patient = require('../models/Patient');
const Encounter = require('../models/Encounter');
const Consent = require('../models/Consent');
const BreakGlass = require('../models/BreakGlass');
const AccessLog = require('../models/AccessLog');
const { authorizePatientRecordAccess } = require('../services/patient-access.service');
const { reviewBreakGlassAuthorization } = require('../services/break-glass-review.service');

const ids = {
  patientUser: new mongoose.Types.ObjectId(),
  doctor: new mongoose.Types.ObjectId(),
  ownPatient: new mongoose.Types.ObjectId(),
  otherPatient: new mongoose.Types.ObjectId(),
  encounter: new mongoose.Types.ObjectId(),
  consent: new mongoose.Types.ObjectId(),
  breakGlass: new mongoose.Types.ObjectId()
};
const originals = {
  userFindById: User.findById,
  patientExists: Patient.exists,
  encounterFindById: Encounter.findById,
  consentFindOne: Consent.findOne,
  breakGlassFind: BreakGlass.find,
  breakGlassFindOne: BreakGlass.findOne,
  breakGlassFindById: BreakGlass.findById,
  breakGlassFindOneAndUpdate: BreakGlass.findOneAndUpdate,
  accessCreate: AccessLog.create
};

let consentStatus;
let logs;
let breakGlassRecord;
let reviewUpdates;

function query(value) {
  return { select() { return this; }, lean: async () => value };
}

function installMocks() {
  consentStatus = 'granted';
  logs = [];
  reviewUpdates = 0;
  breakGlassRecord = null;
  User.findById = (id) => query(String(id) === String(ids.doctor)
    ? { _id: ids.doctor, role: 'doctor', isActive: true }
    : String(id) === String(ids.patientUser)
      ? { _id: ids.patientUser, role: 'patient', patient: ids.ownPatient, isActive: true }
      : null);
  Patient.exists = async ({ _id }) => ({ _id });
  Encounter.findById = () => query({ _id: ids.encounter, patient: ids.ownPatient, assignedDoctor: new mongoose.Types.ObjectId() });
  Consent.findOne = (filter) => query(
    consentStatus === 'granted' && filter.status === 'granted' &&
      String(filter.patient) === String(ids.ownPatient) && String(filter.doctor) === String(ids.doctor)
      ? { _id: ids.consent }
      : null
  );
  BreakGlass.find = () => ({ select() { return this; }, lean: async () => breakGlassRecord ? [{ _id: ids.breakGlass }] : [] });
  BreakGlass.findOne = () => query(breakGlassRecord);
  BreakGlass.findById = () => ({ select() { return this; }, lean: async () => breakGlassRecord });
  BreakGlass.findOneAndUpdate = async () => { reviewUpdates += 1; return null; };
  AccessLog.create = async (log) => { logs.push(log); return log; };
}

function restoreMocks() {
  User.findById = originals.userFindById;
  Patient.exists = originals.patientExists;
  Encounter.findById = originals.encounterFindById;
  Consent.findOne = originals.consentFindOne;
  BreakGlass.find = originals.breakGlassFind;
  BreakGlass.findOne = originals.breakGlassFindOne;
  BreakGlass.findById = originals.breakGlassFindById;
  BreakGlass.findOneAndUpdate = originals.breakGlassFindOneAndUpdate;
  AccessLog.create = originals.accessCreate;
}

test.beforeEach(installMocks);
test.after(restoreMocks);

test('patient cannot view another patient; denial is generic and logged', async () => {
  const result = await authorizePatientRecordAccess(
    { id: String(ids.patientUser), role: 'patient', patient: String(ids.ownPatient) },
    String(ids.otherPatient)
  );
  assert.equal(result.allowed, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.message, 'Access to this patient record is not permitted');
  assert.equal(logs.length, 1);
  assert.equal(String(logs[0].patient), String(ids.otherPatient));
  assert.equal(logs[0].action, 'denied_access');
});

test('doctor consent for one patient cannot authorize a different patient through an encounter', async () => {
  const result = await authorizePatientRecordAccess(
    { id: String(ids.doctor), role: 'doctor' },
    String(ids.otherPatient),
    String(ids.encounter)
  );
  assert.equal(result.allowed, false);
  assert.equal(result.message, 'Access to this patient record is not permitted');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'denied_access');
  assert.equal(logs[0].accessMethod, 'denied');
  assert.equal(logs[0].consent, undefined);
});

test('consent revocation denies the very next patient-access request', async () => {
  const doctor = { id: String(ids.doctor), role: 'doctor' };
  const first = await authorizePatientRecordAccess(doctor, String(ids.ownPatient), String(ids.encounter));
  assert.equal(first.allowed, true);
  assert.equal(logs.at(-1).accessMethod, 'patient_consent');

  consentStatus = 'revoked';
  const next = await authorizePatientRecordAccess(doctor, String(ids.ownPatient), String(ids.encounter));
  assert.equal(next.allowed, false);
  assert.equal(logs.at(-1).action, 'denied_access');
  assert.equal(logs.at(-1).accessMethod, 'denied');
});

test('expired active BreakGlass cannot grant access even if cleanup has not changed its status', async () => {
  breakGlassRecord = {
    _id: ids.breakGlass,
    patient: ids.ownPatient,
    doctor: ids.doctor,
    status: 'active',
    reason: 'Emergency reason with enough meaningful characters',
    expiresAt: new Date(Date.now() - 1000),
    reviewedBy: null,
    reviewedAt: null
  };
  const result = await authorizePatientRecordAccess(
    { id: String(ids.doctor), role: 'doctor' }, String(ids.ownPatient)
  );
  assert.equal(result.allowed, false);
  assert.equal(logs.at(-1).action, 'denied_access');
  assert.equal(logs.at(-1).accessMethod, 'denied');
});

test('admin cannot review their own BreakGlass authorization', async () => {
  User.findById = (id) => query({ _id: new mongoose.Types.ObjectId(String(id)), role: 'admin', isActive: true });
  breakGlassRecord = {
    _id: ids.breakGlass,
    patient: ids.ownPatient,
    doctor: ids.doctor,
    status: 'active',
    activatedAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() + 60_000),
    reviewedBy: null,
    reviewedAt: null
  };
  await assert.rejects(
    reviewBreakGlassAuthorization({ id: String(ids.doctor), role: 'admin' }, String(ids.breakGlass), 'justified'),
    (error) => error.status === 403 && /own emergency authorization/.test(error.message)
  );
  assert.equal(reviewUpdates, 0);
});
