'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const mongoose = require('mongoose');

const doctorId = new mongoose.Types.ObjectId();
const receiverId = new mongoose.Types.ObjectId();
const outsiderId = new mongoose.Types.ObjectId();
const patientId = new mongoose.Types.ObjectId();
const encounterId = new mongoose.Types.ObjectId();
const departmentId = new mongoose.Types.ObjectId();
const department = { _id: departmentId, name: 'Emergency', code: 'ER', isActive: true };
const users = new Map([
  [String(doctorId), { _id: doctorId, role: 'doctor', isActive: true }],
  [String(receiverId), { _id: receiverId, role: 'doctor', isActive: true }],
  [String(outsiderId), { _id: outsiderId, role: 'doctor', isActive: true }]
]);

const patientAccessPath = require.resolve('../services/patient-access.service');
const auditPath = require.resolve('../services/audit-log.service');
const notificationPath = require.resolve('../services/notification.service');
const referralPath = require.resolve('../services/referral.service');
const priorModules = new Map([patientAccessPath, auditPath, notificationPath, referralPath].map((path) => [path, require.cache[path]]));
let records;
let audits;
let notifications;

function installModule(path, exports) {
  const fake = new Module(path);
  fake.filename = path;
  fake.loaded = true;
  fake.exports = exports;
  require.cache[path] = fake;
}

installModule(patientAccessPath, { authorizePatientRecordAccess: async () => ({ allowed: true, accessMethod: 'assigned_visit' }) });
installModule(auditPath, { writeAuditLog: async (entry) => { audits.push(entry); return { id: String(audits.length) }; } });
installModule(notificationPath, { createNotificationOnce: async (entry) => {
  if (notifications.some((item) => item.eventKey === entry.eventKey)) return { replayed: true };
  notifications.push(entry);
  return { replayed: false };
} });

const User = require('../models/User');
const Patient = require('../models/Patient');
const Encounter = require('../models/Encounter');
const DepartmentModel = require('../models/Department');
const Referral = require('../models/Referral');
const AuditLog = require('../models/AuditLog');
const originals = {
  userFindById: User.findById, userFindOne: User.findOne, patientExists: Patient.exists,
  encounterFindById: Encounter.findById, departmentFindOne: DepartmentModel.findOne,
  referralFindById: Referral.findById, referralCreate: Referral.create, referralUpdate: Referral.findOneAndUpdate,
  auditFindOne: AuditLog.findOne
};

function userQuery(id) {
  return { select() { return this; }, lean: async () => users.get(String(id)) || null };
}

function installMocks() {
  records = new Map();
  audits = [];
  notifications = [];
  User.findById = (id) => userQuery(id);
  User.findOne = (filter) => userQuery(filter._id);
  Patient.exists = async (filter) => String(filter._id) === String(patientId) ? { _id: patientId } : null;
  Encounter.findById = () => ({ select() { return this; }, lean: async () => ({ _id: encounterId, patient: patientId }) });
  DepartmentModel.findOne = (filter) => ({
    select() { return this; },
    lean: async () => {
      if (filter._id) return String(filter._id) === String(departmentId) && filter.isActive ? department : null;
      const [nameQuery, codeQuery] = filter.$or;
      return nameQuery.name === department.name || codeQuery.code === department.code ? department : null;
    }
  });
  Referral.findById = (id) => ({ lean: async () => records.get(String(id)) || null });
  Referral.create = async (input) => {
    const record = {
      ...input,
      _id: input._id || new mongoose.Types.ObjectId(),
      createdAt: new Date('2026-11-01T00:00:00Z'),
      updatedAt: new Date('2026-11-01T00:00:00Z')
    };
    records.set(String(record._id), record);
    return record;
  };
  Referral.findOneAndUpdate = (filter, update) => ({
    lean: async () => {
      const record = records.get(String(filter._id));
      if (!record || record.status !== filter.status ||
          (filter.referringDoctor && String(record.referringDoctor) !== String(filter.referringDoctor)) ||
          (filter.receivingDoctor && String(record.receivingDoctor) !== String(filter.receivingDoctor))) return null;
      Object.assign(record, update.$set);
      record.statusHistory.push(update.$push.statusHistory);
      record.updatedAt = new Date();
      return record;
    }
  });
  AuditLog.findOne = (filter) => ({ select() { return this; }, lean: async () => audits.some((entry) =>
    String(entry.actorId) === String(filter.actor) && entry.action === filter.action && String(entry.entityId) === String(filter.entityId) &&
    (!filter['details.operationHash'] || entry.details.operationHash === filter['details.operationHash'])) ? { _id: new mongoose.Types.ObjectId() } : null });
}

installMocks();
const { createReferral, updateReferralStatus } = require('../services/referral.service');

test.after(() => {
  User.findById = originals.userFindById;
  User.findOne = originals.userFindOne;
  Patient.exists = originals.patientExists;
  Encounter.findById = originals.encounterFindById;
  DepartmentModel.findOne = originals.departmentFindOne;
  Referral.findById = originals.referralFindById;
  Referral.create = originals.referralCreate;
  Referral.findOneAndUpdate = originals.referralUpdate;
  AuditLog.findOne = originals.auditFindOne;
  for (const [path, prior] of priorModules) {
    if (prior) require.cache[path] = prior;
    else delete require.cache[path];
  }
});

test('referral stores structured destination, preserves legacy display, status history, and retry-safe notice', async () => {
  const created = await createReferral({
    encounterId: String(encounterId), receivingDepartmentId: String(departmentId), receivingDoctorId: String(receiverId),
    reason: 'Requires specialist review at the receiving service', idempotencyKey: 'referral-created-0001'
  }, { id: String(doctorId) });
  assert.equal(created.receivingDepartment, String(departmentId));
  assert.equal(created.receivingDoctor, String(receiverId));
  assert.equal(created.receivingHospital, department.name);
  assert.deepEqual(created.statusHistory.map((entry) => [entry.status, entry.event]), [['pending', 'created']]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].recipient, receiverId);
  assert.doesNotMatch(notifications[0].message, /patient|reason|clinical/i);

  const replay = await createReferral({
    encounterId: String(encounterId), receivingDepartmentId: String(departmentId), receivingDoctorId: String(receiverId),
    reason: 'Requires specialist review at the receiving service', idempotencyKey: 'referral-created-0001'
  }, { id: String(doctorId) });
  assert.equal(replay.replayed, true);
  assert.equal(records.size, 1);
  assert.equal(notifications.length, 1);
});

test('legacy department-name input remains supported and resolves to the structured active department', async () => {
  const created = await createReferral({
    encounterId: String(encounterId), receivingHospital: 'ER',
    reason: 'Requires specialist review at the receiving service', idempotencyKey: 'referral-legacy-0001'
  }, { id: String(doctorId) });
  assert.equal(created.receivingDepartment, String(departmentId));
  assert.equal(created.receivingHospital, 'Emergency');
});

test('receiving doctor can apply permitted status transitions and history/audit/notice reflect the change', async () => {
  const referral = await createReferral({
    encounterId: String(encounterId), receivingDepartmentId: String(departmentId), receivingDoctorId: String(receiverId),
    reason: 'Requires specialist review at the receiving service', idempotencyKey: 'referral-update-0001'
  }, { id: String(doctorId) });
  const updated = await updateReferralStatus({
    referralId: referral.id, status: 'accepted', idempotencyKey: 'referral-status-0001'
  }, { id: String(receiverId) });
  assert.equal(updated.status, 'accepted');
  assert.deepEqual(updated.statusHistory.map((entry) => [entry.status, entry.event]), [
    ['pending', 'created'], ['accepted', 'status_changed']
  ]);
  assert.equal(notifications.at(-1).recipient, doctorId);
  assert.equal(audits.at(-1).action, 'referral_status_changed');
});

test('unrelated doctor cannot change status and unknown destinations are rejected', async () => {
  const referral = await createReferral({
    encounterId: String(encounterId), receivingDepartmentId: String(departmentId), receivingDoctorId: String(receiverId),
    reason: 'Requires specialist review at the receiving service', idempotencyKey: 'referral-access-0001'
  }, { id: String(doctorId) });
  await assert.rejects(updateReferralStatus({ referralId: referral.id, status: 'accepted', idempotencyKey: 'referral-status-0002' }, { id: String(outsiderId) }), (error) => error.status === 403);
  await assert.rejects(createReferral({
    encounterId: String(encounterId), receivingDepartmentId: String(outsiderId),
    reason: 'Requires specialist review at the receiving service', idempotencyKey: 'referral-unknown-0001'
  }, { id: String(doctorId) }), (error) => error.status === 404);
});

