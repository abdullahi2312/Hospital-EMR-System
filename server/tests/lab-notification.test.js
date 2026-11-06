'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const mongoose = require('mongoose');

const technicianId = new mongoose.Types.ObjectId();
const doctorId = new mongoose.Types.ObjectId();
const patientId = new mongoose.Types.ObjectId();
const encounterId = new mongoose.Types.ObjectId();
const orderId = new mongoose.Types.ObjectId();
const technician = { _id: technicianId, role: 'lab_technician', isActive: true };
const patient = { _id: patientId, mrn: 'MRN-TEST', firstName: 'Test', fatherName: 'User', grandfatherName: 'One' };
const encounter = { _id: encounterId, patient: patientId, visitNumber: 'VISIT-TEST', department: 'LAB', status: 'in_progress' };
const order = {
  _id: orderId, patient: patientId, encounter: encounterId, doctor: doctorId, testName: 'CBC',
  priority: 'routine', status: 'processing', technician: null, orderedAt: new Date('2026-10-01T00:00:00Z')
};

const auditPath = require.resolve('../services/audit-log.service');
const accessPath = require.resolve('../services/patient-access.service');
const notificationPath = require.resolve('../services/notification.service');
const labPath = require.resolve('../services/lab.service');
const priorModules = new Map([auditPath, accessPath, notificationPath, labPath].map((path) => [path, require.cache[path]]));
let results;
let auditEvents;
let notificationEvents;
let failNotification;

function fakeModule(path, exports) {
  const value = new Module(path);
  value.filename = path;
  value.loaded = true;
  value.exports = exports;
  require.cache[path] = value;
}

fakeModule(auditPath, { writeAuditLog: async (event) => { auditEvents.push(event); } });
fakeModule(accessPath, { authorizePatientRecordAccess: async () => ({ allowed: true }) });
fakeModule(notificationPath, { createNotificationOnce: async (event) => {
  if (failNotification) throw new Error('private notification failure');
  if (notificationEvents.some((prior) => prior.eventKey === event.eventKey)) return { replayed: true };
  notificationEvents.push(event);
  return { replayed: false };
} });

const User = require('../models/User');
const Patient = require('../models/Patient');
const Encounter = require('../models/Encounter');
const LabOrder = require('../models/LabOrder');
const LabResult = require('../models/LabResult');
const AuditLog = require('../models/AuditLog');
const originals = {
  userFindById: User.findById, patientFindById: Patient.findById, encounterFindById: Encounter.findById,
  orderFindById: LabOrder.findById, orderUpdate: LabOrder.findOneAndUpdate,
  resultFindById: LabResult.findById, resultFindOne: LabResult.findOne, resultFind: LabResult.find,
  resultSave: LabResult.prototype.save, auditFindOne: AuditLog.findOne
};

function query(value) { return { select() { return this; }, lean: async () => value }; }

function installMocks() {
  results = new Map();
  auditEvents = [];
  notificationEvents = [];
  failNotification = false;
  Object.assign(order, { status: 'processing', technician: null });
  User.findById = (id) => query(String(id) === String(technicianId) ? technician : null);
  Patient.findById = () => query(patient);
  Encounter.findById = () => query(encounter);
  LabOrder.findById = () => query(order);
  LabOrder.findOneAndUpdate = (_filter, update) => {
    Object.assign(order, update.$set);
    return Promise.resolve(order);
  };
  LabResult.findById = (id) => query(results.get(String(id)) || null);
  LabResult.findOne = () => ({ select() { return this; }, lean: async () => null });
  LabResult.find = () => ({ select() { return this; }, lean: async () => [...results.values()] });
  LabResult.prototype.save = async function saveMock() {
    results.set(String(this._id), this);
    return this;
  };
  AuditLog.findOne = (filter) => ({ select() { return this; }, lean: async () => auditEvents.some((event) =>
    String(event.actorId) === String(filter.actor) && event.action === filter.action && String(event.entityId) === String(filter.entityId))
    ? { _id: new mongoose.Types.ObjectId() } : null });
}

installMocks();
const { recordLabResult } = require('../services/lab.service');

test.after(() => {
  User.findById = originals.userFindById;
  Patient.findById = originals.patientFindById;
  Encounter.findById = originals.encounterFindById;
  LabOrder.findById = originals.orderFindById;
  LabOrder.findOneAndUpdate = originals.orderUpdate;
  LabResult.findById = originals.resultFindById;
  LabResult.findOne = originals.resultFindOne;
  LabResult.find = originals.resultFind;
  LabResult.prototype.save = originals.resultSave;
  AuditLog.findOne = originals.auditFindOne;
  for (const [path, previous] of priorModules) {
    if (previous) require.cache[path] = previous;
    else delete require.cache[path];
  }
});

const resultInput = {
  orderId: String(orderId), resultType: 'numeric', numericValue: 4.2, unit: '10^9/L',
  referenceRange: { minimum: 3, maximum: 10 }, idempotencyKey: 'lab-result-ready-0001'
};

test('completing the lab order creates one generic notification and retry does not duplicate it', async () => {
  const first = await recordLabResult(resultInput, { id: String(technicianId) });
  assert.equal(order.status, 'completed');
  assert.equal(notificationEvents.length, 1);
  assert.equal(notificationEvents[0].recipient, doctorId);
  assert.equal(notificationEvents[0].type, 'lab_result_ready');
  assert.doesNotMatch(notificationEvents[0].message, /4\.2|MRN|patient|CBC|10\^9/i);
  const replay = await recordLabResult(resultInput, { id: String(technicianId) });
  assert.equal(replay.replayed, true);
  assert.equal(notificationEvents.length, 1);
  assert.equal(first.orderId, String(orderId));
});

test('notification failure reports partial completion and the same result retry recovers the notice', async () => {
  failNotification = true;
  await assert.rejects(recordLabResult(resultInput, { id: String(technicianId) }), (error) => error.status === 503 && error.partialSuccess === true);
  assert.equal(order.status, 'completed');
  assert.equal(results.size, 1);
  failNotification = false;
  const recovered = await recordLabResult(resultInput, { id: String(technicianId) });
  assert.equal(recovered.replayed, true);
  assert.equal(notificationEvents.length, 1);
});

