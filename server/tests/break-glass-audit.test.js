'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const User = require('../models/User');
const Patient = require('../models/Patient');
const BreakGlass = require('../models/BreakGlass');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');
const smsAdapter = require('../adapters/sms.adapter');
const { createBreakGlassAuthorization } = require('../services/break-glass.service');

const ids = { doctor: new mongoose.Types.ObjectId(), patient: new mongoose.Types.ObjectId(), admin: new mongoose.Types.ObjectId() };
const originals = {
  startSession: mongoose.startSession,
  userFindById: User.findById,
  userFind: User.find,
  patientExists: Patient.exists,
  breakGlassSave: BreakGlass.prototype.save,
  notificationInsertMany: Notification.insertMany,
  auditSave: AuditLog.prototype.save
};
const originalSendSms = smsAdapter.sendSms;

let savedAuthorizations;
let savedNotifications;
let savedAudits;
let failAudit;
let admins;

function installMocks() {
  savedAuthorizations = [];
  savedNotifications = [];
  savedAudits = [];
  failAudit = false;
  admins = [{ _id: ids.admin }];
  mongoose.startSession = async () => ({
    async withTransaction(callback) { await callback(); },
    async endSession() {}
  });
  User.findById = (id) => ({
    select() { return this; },
    lean: async () => String(id) === String(ids.doctor)
      ? { _id: ids.doctor, role: 'doctor', isActive: true }
      : String(id) === String(ids.admin)
        ? { _id: ids.admin }
        : null
  });
  User.find = () => ({
    select() { return this; },
    session() { return this; },
    lean: async () => admins
  });
  Patient.exists = async ({ _id }) => String(_id) === String(ids.patient) ? { _id } : null;
  BreakGlass.prototype.save = async function saveAuthorizationMock() {
    savedAuthorizations.push(this);
    return this;
  };
  Notification.insertMany = async (notifications) => {
    savedNotifications.push(...notifications);
    return notifications;
  };
  AuditLog.prototype.save = async function saveAuditMock() {
    if (failAudit) throw new Error('private audit database failure');
    savedAudits.push(this.toObject({ depopulate: true }));
    return this;
  };
}

function restoreMocks() {
  mongoose.startSession = originals.startSession;
  User.findById = originals.userFindById;
  User.find = originals.userFind;
  Patient.exists = originals.patientExists;
  BreakGlass.prototype.save = originals.breakGlassSave;
  Notification.insertMany = originals.notificationInsertMany;
  AuditLog.prototype.save = originals.auditSave;
  smsAdapter.sendSms = originalSendSms;
}

test.beforeEach(installMocks);
test.after(restoreMocks);

test('BreakGlass activation writes a general audit event without reason or patient details', async () => {
  const reason = 'Urgent emergency assessment requires immediate patient record access';
  const result = await createBreakGlassAuthorization(
    { id: String(ids.doctor), role: 'doctor' }, String(ids.patient), reason
  );
  assert.equal(result.notificationCount, 1);
  assert.equal(savedAudits.length, 1);
  assert.equal(String(savedAudits[0].actor), String(ids.doctor));
  assert.equal(savedAudits[0].action, 'break_glass_activated');
  assert.equal(savedAudits[0].entityType, 'BreakGlass');
  assert.equal(String(savedAudits[0].entityId), result.id);
  assert.equal(savedAudits[0].details, undefined);
  assert.equal(JSON.stringify(savedAudits[0]).includes(reason), false);
  assert.equal(Object.hasOwn(savedAudits[0], 'patient'), false);
  assert.equal(savedNotifications.length, 1);
  assert.equal(savedNotifications[0].message.includes(reason), false);
});

test('BreakGlass activation reports an explicit partial result when audit persistence fails', async () => {
  failAudit = true;
  await assert.rejects(
    createBreakGlassAuthorization(
      { id: String(ids.doctor), role: 'doctor' }, String(ids.patient),
      'Urgent emergency assessment requires immediate patient record access'
    ),
    (error) => error.status === 503 && error.breakGlassMayRemainWithoutAudit === true && Boolean(error.breakGlassId)
  );
  assert.equal(savedAuthorizations.length, 1);
  assert.equal(savedNotifications.length, 1);
  assert.equal(savedAudits.length, 0);
});

test('active administrators receive only a simulated privacy-preserving SMS attempt', async () => {
  admins = [{ _id: ids.admin, phone: '+252611234567' }];
  const attempts = [];
  smsAdapter.sendSms = async (input) => {
    attempts.push(input);
    return { simulated: true, deliveryStatus: 'simulated_success', provider: 'simulated' };
  };
  const reason = 'Urgent emergency assessment requires immediate patient record access';
  const result = await createBreakGlassAuthorization({ id: String(ids.doctor) }, String(ids.patient), reason);
  assert.deepEqual(result.smsDelivery, { simulated: true, status: 'simulated_success', attempted: 1, succeeded: 1, failed: 0, skipped: 0 });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].phoneNumber, admins[0].phone);
  assert.equal(attempts[0].idempotencyKey.includes(result.id), true);
  assert.doesNotMatch(attempts[0].message, new RegExp(`${ids.patient}|${reason}|${ids.doctor}`));
  assert.equal(result.notificationCount, 1);
});

test('simulated SMS failure is reported without undoing completed in-app notification or authorization', async () => {
  admins = [{ _id: ids.admin, phone: '+252611234567' }];
  smsAdapter.sendSms = async () => ({ simulated: true, deliveryStatus: 'simulated_failure', provider: 'simulated' });
  const result = await createBreakGlassAuthorization(
    { id: String(ids.doctor) }, String(ids.patient),
    'Urgent emergency assessment requires immediate patient record access'
  );
  assert.equal(result.status, 'active');
  assert.equal(result.notificationCount, 1);
  assert.equal(result.smsDelivery.status, 'simulated_partial_failure');
  assert.equal(result.smsDelivery.failed, 1);
  assert.equal(savedAudits.length, 1);
});

test('no active administrators is explicit and does not attempt simulated SMS', async () => {
  admins = [];
  const oldSend = smsAdapter.sendSms;
  let calls = 0;
  smsAdapter.sendSms = async () => { calls += 1; throw new Error('must not call'); };
  try {
    const result = await createBreakGlassAuthorization(
      { id: String(ids.doctor) }, String(ids.patient),
      'Urgent emergency assessment requires immediate patient record access'
    );
    assert.equal(result.notificationStatus, 'no_active_admins');
    assert.equal(result.notificationCount, 0);
    assert.equal(result.smsDelivery.status, 'not_attempted');
    assert.equal(calls, 0);
  } finally {
    smsAdapter.sendSms = oldSend;
  }
});
