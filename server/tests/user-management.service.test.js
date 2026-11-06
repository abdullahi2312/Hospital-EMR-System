'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const Patient = require('../models/Patient');
const AuditLog = require('../models/AuditLog');
const { comparePassword } = require('../utils/password');

const users = new Map();
const patients = new Set();
let auditEvents = [];
let failNextAudit = false;
let lastStatusFilter;

function plain(value) {
  if (value && typeof value.toObject === 'function') return value.toObject();
  return value;
}

function query(value) {
  return {
    select() { return this; },
    sort(sortValue) { this.sortValue = sortValue; return this; },
    skip(count) { this.offset = count; return this; },
    limit(count) { this.maximum = count; return this; },
    lean() {
      let result = Array.isArray(value) ? value.map(plain) : plain(value);
      if (Array.isArray(result) && this.sortValue) {
        result.sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0));
      }
      if (Array.isArray(result) && this.maximum !== undefined) {
        result = result.slice(this.offset || 0, (this.offset || 0) + this.maximum);
      }
      return Promise.resolve(result);
    }
  };
}

function idString(value) { return value == null ? '' : String(value); }

function reset() {
  users.clear();
  patients.clear();
  auditEvents = [];
  failNextAudit = false;
  lastStatusFilter = null;
  const adminId = new mongoose.Types.ObjectId();
  users.set(String(adminId), { _id: adminId, role: 'admin', isActive: true, fullName: 'System Admin', username: 'admin', createdAt: new Date('2026-01-01T00:00:00Z') });
  return { adminId };
}

User.findById = (id) => query(users.get(String(id)) || null);
User.findOne = (filter) => {
  let found = null;
  if (filter.username !== undefined) {
    found = [...users.values()].find((user) => user.username === filter.username) || null;
  } else if (filter.patient !== undefined) {
    found = [...users.values()].find((user) => idString(user.patient) === idString(filter.patient)) || null;
  }
  return query(found);
};
User.find = () => query([...users.values()]);
User.countDocuments = async () => users.size;
User.findOneAndUpdate = (filter, update) => {
  lastStatusFilter = filter;
  const current = users.get(String(filter._id));
  if (!current || current.isActive !== filter.isActive) return query(null);
  if (current && typeof current.set === 'function') current.set(update.$set);
  else Object.assign(current, update.$set);
  current.updatedAt = new Date();
  users.set(String(filter._id), current);
  return query(current);
};
User.prototype.save = async function mockedSave() {
  const key = String(this._id);
  if ([...users.values()].some((saved) => saved.username === this.username && String(saved._id) !== key)) {
    const duplicate = new Error('duplicate username');
    duplicate.code = 11000;
    duplicate.keyPattern = { username: 1 };
    throw duplicate;
  }
  if (this.patient && [...users.values()].some((saved) => idString(saved.patient) === idString(this.patient) && String(saved._id) !== key)) {
    const duplicate = new Error('duplicate patient');
    duplicate.code = 11000;
    duplicate.keyPattern = { patient: 1 };
    throw duplicate;
  }
  this.createdAt ||= new Date();
  this.updatedAt ||= this.createdAt;
  users.set(key, this);
  return this;
};

Patient.findById = (id) => query(patients.has(String(id)) ? { _id: new mongoose.Types.ObjectId(String(id)) } : null);

AuditLog.findOne = (filter) => {
  const storedHashFilter = filter['details.idempotencyHash'];
  const acceptedHashes = storedHashFilter && typeof storedHashFilter === 'object' && Array.isArray(storedHashFilter.$in)
    ? storedHashFilter.$in
    : storedHashFilter === undefined ? null : [storedHashFilter];
  const event = auditEvents.find((item) => idString(item.actorId) === idString(filter.actor) &&
    item.action === filter.action && item.entityType === filter.entityType &&
    idString(item.entityId) === idString(filter.entityId) &&
    (!acceptedHashes || acceptedHashes.includes(item.details?.idempotencyHash)));
  return query(event ? { _id: new mongoose.Types.ObjectId(), details: event.details } : null);
};

const auditPath = require.resolve('../services/audit-log.service');
const auditModule = new (require('node:module'))(auditPath);
auditModule.filename = auditPath;
auditModule.loaded = true;
auditModule.exports = {
  async writeAuditLog(event) {
    if (failNextAudit) {
      failNextAudit = false;
      throw new Error('mock audit failure');
    }
    auditEvents.push(event);
    return { id: new mongoose.Types.ObjectId().toString() };
  }
};
require.cache[auditPath] = auditModule;

const service = require('../services/user-management.service');

function adminContext(id, claimedRole = 'admin') {
  return { id: String(id), role: claimedRole };
}

test('user management service enforces admin policy, account safety, paging, and auditable status changes using mocked persistence', async (t) => {
  const { adminId } = reset();

  await t.test('creates a user with hashed password, safe result, and idempotent replay', async () => {
    const input = {
      fullName: '  Asha Hassan  ', username: '  ASHA.HASSAN ', password: 'Valid Password 123!',
      role: 'doctor', phone: '+252 61 234 5678', idempotencyKey: 'create-doctor-0001'
    };
    const created = await service.createManagedUser(input, adminContext(adminId, 'receptionist'));
    assert.equal(created.role, 'doctor');
    assert.equal(created.fullName, 'Asha Hassan');
    assert.equal(created.username, 'asha.hassan');
    assert.equal(created.isActive, true);
    assert.equal(Object.hasOwn(created, 'password'), false);
    assert.equal(Object.hasOwn(created, 'phone'), false);
    assert.equal(Object.hasOwn(created, 'passwordHash'), false);

    const saved = users.get(created.id);
    assert.notEqual(saved.password, input.password);
    assert.equal(await comparePassword(input.password, saved.password), true);
    assert.equal(auditEvents.length, 1);
    assert.equal(String(auditEvents[0].actorId), String(adminId));
    assert.equal(String(auditEvents[0].entityId), created.id);
    assert.equal(auditEvents[0].action, 'user_created');
    assert.doesNotMatch(JSON.stringify(auditEvents[0].details), /asha|password|phone|hassan/i);
    assert.match(auditEvents[0].details.idempotencyHash, /^[A-P]{64}$/);

    // Simulate an audit event persisted by the previous hexadecimal format.
    const legacyHash = crypto.createHash('sha256')
      .update(`managed-user:${adminId}:create-doctor-0001`)
      .digest('hex');
    auditEvents[0].details.idempotencyHash = legacyHash;

    const replay = await service.createManagedUser(input, adminContext(adminId));
    assert.equal(replay.id, created.id);
    assert.equal(replay.replayed, true);
    assert.equal(users.size, 2);
    assert.equal(auditEvents.length, 1);
  });

  await t.test('supports the five provisionable roles and links only valid patient accounts', async () => {
    const patientId = new mongoose.Types.ObjectId();
    patients.add(String(patientId));
    const roles = ['receptionist', 'lab_technician', 'pharmacist'];
    for (const [index, role] of roles.entries()) {
      const created = await service.createManagedUser({
        fullName: `Staff Member ${index}`,
        username: `staff-${role}`,
        password: 'Valid Password 123!',
        role,
        idempotencyKey: `staff-key-${index}-0001`
      }, adminContext(adminId));
      assert.equal(created.role, role);
      assert.equal(created.patient, undefined);
    }
    const linked = await service.createManagedUser({
      fullName: 'Patient Portal', username: 'patient.portal', password: 'Valid Password 123!',
      role: 'patient', patient: String(patientId), idempotencyKey: 'patient-key-0001'
    }, adminContext(adminId));
    assert.equal(linked.patient, String(patientId));
    await assert.rejects(service.createManagedUser({
      fullName: 'Duplicate Username', username: 'STAFF-RECEPTIONIST', password: 'Valid Password 123!',
      role: 'doctor', idempotencyKey: 'duplicate-username-001'
    }, adminContext(adminId)), (error) => error.status === 409);
    const patientCreationAudit = auditEvents.find((event) => String(event.entityId) === linked.id && event.action === 'user_created');
    assert.equal(patientCreationAudit.details.portalAccount, true);
    assert.equal(Object.hasOwn(patientCreationAudit.details, 'role'), false);
    assert.match(patientCreationAudit.details.idempotencyHash, /^[A-P]{64}$/);
    const auditDocument = new AuditLog({
      actor: adminId,
      action: patientCreationAudit.action,
      entityType: patientCreationAudit.entityType,
      entityId: patientCreationAudit.entityId,
      details: patientCreationAudit.details
    });
    await auditDocument.validate();
    const legacyHexWithPhoneLikeDigitRun = new AuditLog({
      actor: adminId,
      action: 'user_created',
      entityType: 'User',
      entityId: linked.id,
      details: { idempotencyHash: '0123456789abcdef'.repeat(4) }
    });
    await assert.rejects(legacyHexWithPhoneLikeDigitRun.validate(), (error) => (
      error.name === 'ValidationError' && Boolean(error.errors.details)
    ));
    await assert.rejects(service.createManagedUser({
      fullName: 'Duplicate Portal', username: 'duplicate.portal', password: 'Valid Password 123!',
      role: 'patient', patient: String(patientId), idempotencyKey: 'patient-key-0002'
    }, adminContext(adminId)), (error) => error.status === 409);
    await assert.rejects(service.createManagedUser({
      fullName: 'Unlinked Patient', username: 'unlinked.patient', password: 'Valid Password 123!',
      role: 'patient', idempotencyKey: 'patient-key-0003'
    }, adminContext(adminId)), (error) => error.status === 400);
    await assert.rejects(service.createManagedUser({
      fullName: 'Unknown Patient', username: 'unknown.patient', password: 'Valid Password 123!',
      role: 'patient', patient: String(new mongoose.Types.ObjectId()), idempotencyKey: 'patient-key-0004'
    }, adminContext(adminId)), (error) => error.status === 404);
    await assert.rejects(service.createManagedUser({
      fullName: 'Not Portal', username: 'not.portal', password: 'Valid Password 123!',
      role: 'doctor', patient: String(new mongoose.Types.ObjectId()), idempotencyKey: 'patient-key-0005'
    }, adminContext(adminId)), (error) => error.status === 400);
    await assert.rejects(service.createManagedUser({
      fullName: 'Admin Attempt', username: 'admin.attempt', password: 'Valid Password 123!',
      role: 'admin', idempotencyKey: 'admin-key-0001'
    }, adminContext(adminId)), (error) => error.status === 403);
  });

  await t.test('requires a current active database admin and rejects spoofed or unsupported fields', async () => {
    await assert.rejects(service.listManagedUsers({}, { id: String(new mongoose.Types.ObjectId()), role: 'admin' }), (error) => error.status === 401);
    users.set(String(adminId), { _id: adminId, role: 'admin', isActive: false });
    await assert.rejects(service.getManagedUser(String(adminId), adminContext(adminId)), (error) => error.status === 401);
    users.set(String(adminId), { _id: adminId, role: 'doctor', isActive: true });
    await assert.rejects(service.listManagedUsers({}, adminContext(adminId)), (error) => error.status === 403);
    users.set(String(adminId), { _id: adminId, role: 'admin', isActive: true });

    const base = { fullName: 'New User', username: 'new.user', password: 'Valid Password 123!', role: 'doctor', idempotencyKey: 'spoof-key-0001' };
    await assert.rejects(service.createManagedUser({ ...base, role: 'admin' }, adminContext(adminId)), (error) => error.status === 403);
    await assert.rejects(service.createManagedUser({ ...base, actorId: String(adminId) }, adminContext(adminId)), /unsupported or server-managed/);
    await assert.rejects(service.createManagedUser({ ...base, _id: String(new mongoose.Types.ObjectId()) }, adminContext(adminId)), /unsupported or server-managed/);
    await assert.rejects(service.createManagedUser({ ...base, passwordHash: '$2b$12$somehash' }, adminContext(adminId)), /unsupported or server-managed/);
    await assert.rejects(service.createManagedUser({ ...base, createdAt: new Date() }, adminContext(adminId)), /unsupported or server-managed/);
    await assert.rejects(service.createManagedUser({ ...base, email: 'user@example.com' }, adminContext(adminId)), /unsupported or server-managed/);
  });

  await t.test('retrieval and listing use safe fields and validated pagination', async () => {
    const user = await service.createManagedUser({
      fullName: 'Visible User', username: 'visible.user', password: 'Valid Password 123!',
      role: 'doctor', phone: 'private-phone', idempotencyKey: 'visible-key-0001'
    }, adminContext(adminId));
    const detail = await service.getManagedUser(user.id, adminContext(adminId));
    assert.equal(detail.username, 'visible.user');
    assert.equal(Object.hasOwn(detail, 'password'), false);
    assert.equal(Object.hasOwn(detail, 'phone'), false);
    assert.equal(Object.hasOwn(detail, 'patientClinicalData'), false);
    const page = await service.listManagedUsers({ page: '1', limit: '1' }, adminContext(adminId));
    assert.equal(page.users.length, 1);
    assert.equal(page.pagination.limit, 1);
    assert.equal(Object.hasOwn(page.users[0], 'password'), false);
    assert.equal(Object.hasOwn(page.users[0], 'phone'), false);
    await assert.rejects(service.getManagedUser('invalid-id', adminContext(adminId)), (error) => error.status === 400);
    await assert.rejects(service.listManagedUsers({ limit: '101' }, adminContext(adminId)), (error) => error.status === 400);
    await assert.rejects(service.listManagedUsers({ role: 'admin' }, adminContext(adminId)), /unsupported/);
  });

  await t.test('status updates are atomic, audited, idempotent, and cannot deactivate the acting admin', async () => {
    const targetId = new mongoose.Types.ObjectId();
    users.set(String(targetId), { _id: targetId, fullName: 'Target', username: 'target', role: 'doctor', isActive: true });
    const inactive = await service.updateManagedUserStatus({ userId: String(targetId), isActive: false, idempotencyKey: 'status-off-0001' }, adminContext(adminId));
    assert.equal(inactive.isActive, false);
    assert.deepEqual(lastStatusFilter, { _id: targetId, isActive: true });
    assert.equal(auditEvents.at(-1).action, 'user_status_changed');
    assert.match(auditEvents.at(-1).details.idempotencyHash, /^[A-P]{64}$/);
    assert.deepEqual(auditEvents.at(-1).details.isActive, false);
    assert.equal(Object.hasOwn(auditEvents.at(-1).details, 'phone'), false);
    const replay = await service.updateManagedUserStatus({ userId: String(targetId), isActive: false, idempotencyKey: 'status-off-0001' }, adminContext(adminId));
    assert.equal(replay.replayed, true);
    assert.equal(auditEvents.filter((event) => event.action === 'user_status_changed').length, 1);
    const activated = await service.updateManagedUserStatus({ userId: String(targetId), isActive: true, idempotencyKey: 'status-on-0001' }, adminContext(adminId));
    assert.equal(activated.isActive, true);
    assert.deepEqual(lastStatusFilter, { _id: targetId, isActive: false });

    await assert.rejects(service.updateManagedUserStatus({ userId: String(adminId), isActive: false, idempotencyKey: 'self-disable-001' }, adminContext(adminId)), (error) => error.status === 403);
    await assert.rejects(service.updateManagedUserStatus({ userId: String(targetId), isActive: 'active', idempotencyKey: 'bad-status-0001' }, adminContext(adminId)), (error) => error.status === 400);
    await assert.rejects(service.updateManagedUserStatus({ userId: 'not-an-id', isActive: true, idempotencyKey: 'bad-id-key-001' }, adminContext(adminId)), (error) => error.status === 400);
    await assert.rejects(service.updateManagedUserStatus({ userId: String(targetId), isActive: true, idempotencyKey: 'bad-role-0001', role: 'admin' }, adminContext(adminId)), /unsupported/);

    const malformedId = new mongoose.Types.ObjectId();
    users.set(String(malformedId), { _id: malformedId, fullName: 'Malformed', username: 'malformed', role: 'doctor' });
    await assert.rejects(service.updateManagedUserStatus({ userId: String(malformedId), isActive: false, idempotencyKey: 'bad-existing-status' }, adminContext(adminId)), (error) => error.status === 409);
  });

  await t.test('audit failures are explicit and retries repair creation and status audit without duplicate accounts', async () => {
    const userCountBefore = users.size;
    const input = { fullName: 'Audit Recovery', username: 'audit.recovery', password: 'Valid Password 123!', role: 'pharmacist', idempotencyKey: 'audit-create-0001' };
    failNextAudit = true;
    await assert.rejects(service.createManagedUser(input, adminContext(adminId)), (error) => error.status === 503 && error.partialSuccess === true && Boolean(error.userId));
    assert.equal(users.size, userCountBefore + 1);
    const recovered = await service.createManagedUser(input, adminContext(adminId));
    assert.equal(recovered.replayed, true);
    assert.equal(users.size, userCountBefore + 1);

    const targetId = new mongoose.Types.ObjectId();
    users.set(String(targetId), { _id: targetId, fullName: 'Target', username: 'audit-target', role: 'doctor', isActive: true });
    failNextAudit = true;
    await assert.rejects(service.updateManagedUserStatus({ userId: String(targetId), isActive: false, idempotencyKey: 'audit-status-0001' }, adminContext(adminId)), (error) => error.status === 503 && error.partialSuccess === true);
    assert.equal(users.get(String(targetId)).isActive, false);
    const recoveredStatus = await service.updateManagedUserStatus({ userId: String(targetId), isActive: false, idempotencyKey: 'audit-status-0001' }, adminContext(adminId));
    assert.equal(recoveredStatus.replayed, true);
    assert.equal(auditEvents.filter((event) => String(event.entityId) === String(targetId) && event.action === 'user_status_changed').length, 1);
  });
});
