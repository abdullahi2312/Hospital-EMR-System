'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const mongoose = require('mongoose');

const patientUserId = new mongoose.Types.ObjectId();
const doctorId = new mongoose.Types.ObjectId();
const patientId = new mongoose.Types.ObjectId();
const patientAccount = { _id: patientUserId, role: 'patient', patient: patientId, isActive: true };
const doctorAccount = { _id: doctorId, role: 'doctor', isActive: true };
const auditPath = require.resolve('../services/audit-log.service');
const notificationPath = require.resolve('../services/notification.service');
const consentPath = require.resolve('../services/consent.service');
const priorModules = new Map([auditPath, notificationPath, consentPath].map((path) => [path, require.cache[path]]));
let consents;
let audits;
let notifications;
let failNotification;

function fakeModule(path, exports) {
  const value = new Module(path);
  value.filename = path;
  value.loaded = true;
  value.exports = exports;
  require.cache[path] = value;
}

fakeModule(auditPath, { writeAuditLog: async (event) => { audits.push(event); } });
fakeModule(notificationPath, { createNotificationOnce: async (event) => {
  if (failNotification) throw new Error('private notification failure');
  const found = notifications.find((item) => item.eventKey === event.eventKey);
  if (found) return { replayed: true };
  notifications.push(event);
  return { replayed: false };
} });

const User = require('../models/User');
const Patient = require('../models/Patient');
const Consent = require('../models/Consent');
const AuditLog = require('../models/AuditLog');
const originals = {
  userFindById: User.findById, patientExists: Patient.exists, consentFindOne: Consent.findOne,
  consentCreate: Consent.create, consentFindById: Consent.findById, consentUpdate: Consent.findOneAndUpdate,
  auditFindOne: AuditLog.findOne
};

function userQuery(id) {
  const person = String(id) === String(patientUserId) ? patientAccount
    : String(id) === String(doctorId) ? doctorAccount : null;
  return { select() { return this; }, lean: async () => person };
}

function installMocks() {
  consents = new Map();
  audits = [];
  notifications = [];
  failNotification = false;
  User.findById = (id) => userQuery(id);
  Patient.exists = async () => ({ _id: patientId });
  Consent.findOne = (filter) => ({ lean: async () => [...consents.values()].find((item) =>
    String(item.patient) === String(filter.patient) && String(item.doctor) === String(filter.doctor) &&
    item.scope === filter.scope && item.status === filter.status) || null });
  Consent.create = async (input) => {
    const record = { ...input, status: 'granted', _id: new mongoose.Types.ObjectId(), grantedAt: new Date(), createdAt: new Date(), updatedAt: new Date() };
    consents.set(String(record._id), record);
    return record;
  };
  Consent.findById = (id) => ({ lean: async () => consents.get(String(id)) || null });
  Consent.findOneAndUpdate = (filter) => ({ lean: async () => {
    const record = consents.get(String(filter._id));
    if (!record || String(record.patient) !== String(filter.patient) || String(record.grantedBy) !== String(filter.grantedBy) || record.status !== 'granted') return null;
    record.status = 'revoked';
    record.revokedAt = new Date();
    return record;
  } });
  AuditLog.findOne = (filter) => ({ select() { return this; }, lean: async () => audits.some((item) =>
    String(item.actorId) === String(filter.actor) && item.action === filter.action && String(item.entityId) === String(filter.entityId))
    ? { _id: new mongoose.Types.ObjectId() } : null });
}

const { grantPatientConsent, revokePatientConsent } = require('../services/consent.service');
test.beforeEach(installMocks);

test.after(() => {
  User.findById = originals.userFindById;
  Patient.exists = originals.patientExists;
  Consent.findOne = originals.consentFindOne;
  Consent.create = originals.consentCreate;
  Consent.findById = originals.consentFindById;
  Consent.findOneAndUpdate = originals.consentUpdate;
  AuditLog.findOne = originals.auditFindOne;
  for (const [path, previous] of priorModules) {
    if (previous) require.cache[path] = previous;
    else delete require.cache[path];
  }
});

test('consent grant/revoke notify the active doctor without consent notes or patient identity in the message', async () => {
  const consent = await grantPatientConsent({ doctorId: String(doctorId), notes: 'Patient supplied optional note' }, { id: String(patientUserId) });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].recipient, doctorId);
  assert.equal(notifications[0].type, 'general');
  assert.equal(notifications[0].relatedModel, 'Consent');
  assert.doesNotMatch(notifications[0].message, /patient supplied|patientId|clinical/i);
  const revoked = await revokePatientConsent(consent.id, { id: String(patientUserId) });
  assert.equal(revoked.status, 'revoked');
  assert.equal(notifications.length, 2);
  assert.match(notifications[1].message, /revoked/i);
});

test('consent notification failure is explicit and the same grant retry recovers without duplicate consent', async () => {
  failNotification = true;
  const input = { doctorId: String(doctorId) };
  await assert.rejects(grantPatientConsent(input, { id: String(patientUserId) }), (error) => error.status === 503 && error.notificationFailure === true);
  assert.equal(consents.size, 1);
  failNotification = false;
  const replay = await grantPatientConsent(input, { id: String(patientUserId) });
  assert.equal(replay.replayed, true);
  assert.equal(consents.size, 1);
  assert.equal(notifications.length, 1);
});

