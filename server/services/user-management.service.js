const crypto = require('node:crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const Patient = require('../models/Patient');
const AuditLog = require('../models/AuditLog');
const { createUser } = require('./user.service');
const { comparePassword } = require('../utils/password');
const { writeAuditLog } = require('./audit-log.service');

const USER_ROLES = User.schema.path('role').enumValues;
const PROVISIONABLE_ROLES = new Set(USER_ROLES.filter((role) => role !== 'admin'));
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_PAGE_NUMBER = 1000000;
const auditOperations = new Map();
const statusOperations = new Map();
const pendingStatusAudits = new Map();

function managementError(message, status = 400, properties = {}) {
  const error = new Error(message);
  error.name = 'UserManagementServiceError';
  error.status = status;
  error.statusCode = status;
  Object.assign(error, properties);
  return error;
}

function validObjectId(value) {
  return mongoose.isObjectIdOrHexString(value);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw managementError(`${label} must be an object`);
  }
}

function rejectUnknownFields(input, allowedFields, label) {
  if (Object.keys(input).some((field) => !allowedFields.has(field))) {
    throw managementError(`${label} contains unsupported or server-managed fields`);
  }
}

function normalizeText(value, field, maximumLength, minimumLength = 1, required = true) {
  if (value === undefined || value === null) {
    if (required) throw managementError(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw managementError(`${field} must be text`);
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if ((required && normalized.length < minimumLength) || normalized.length > maximumLength) {
    throw managementError(`${field} is invalid`);
  }
  return normalized || undefined;
}

function normalizeIdempotencyKey(value) {
  const key = normalizeText(value, 'idempotencyKey', 128, 8);
  return key;
}

function deterministicUserId(adminId, key) {
  const bytes = crypto.createHash('sha256')
    .update(`managed-user:${adminId}:${key}`)
    .digest()
    .subarray(0, 12);
  return new mongoose.Types.ObjectId(bytes);
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function encodeAuditDigest(hexDigest) {
  if (typeof hexDigest !== 'string' || !/^[a-f0-9]{64}$/.test(hexDigest)) {
    throw managementError('Unable to prepare account audit metadata', 500);
  }
  // AuditLog treats long decimal runs as phone-like values. An A-P nibble
  // alphabet preserves the SHA-256 digest without introducing numeric runs.
  return [...hexDigest].map((nibble) => String.fromCharCode(65 + Number.parseInt(nibble, 16))).join('');
}

async function requireActiveAdmin(adminUser) {
  if (!adminUser || typeof adminUser !== 'object' || !validObjectId(adminUser.id)) {
    throw managementError('Authentication required', 401);
  }

  let currentAdmin;
  try {
    currentAdmin = await User.findById(String(adminUser.id)).select('_id role isActive').lean();
  } catch (_) {
    throw managementError('Unable to verify administrator authorization', 500);
  }
  if (!currentAdmin || currentAdmin.isActive !== true) {
    throw managementError('Authentication required', 401);
  }
  if (currentAdmin.role !== 'admin') {
    throw managementError('Only active administrators may manage user accounts', 403);
  }
  return { id: currentAdmin._id.toString() };
}

function normalizeCreateInput(input) {
  requireObject(input, 'User input');
  rejectUnknownFields(input, new Set([
    'fullName', 'username', 'password', 'role', 'patient', 'phone', 'idempotencyKey'
  ]), 'User input');

  const fullName = normalizeText(input.fullName, 'Full name', 100, 2);
  const username = normalizeText(input.username, 'Username', 30, 3).toLowerCase();
  const role = normalizeText(input.role, 'Role', 30).toLowerCase();
  if (!USER_ROLES.includes(role)) {
    throw managementError('Role must be one of the supported user roles');
  }
  if (!PROVISIONABLE_ROLES.has(role)) {
    throw managementError('Admin accounts cannot be created through ordinary user provisioning', 403);
  }
  if (typeof input.password !== 'string' || input.password.trim().length === 0) {
    throw managementError('Password must be a non-empty string');
  }

  let patientId;
  if (role === 'patient') {
    if (!validObjectId(input.patient)) throw managementError('A valid Patient ID is required for patient accounts');
    patientId = new mongoose.Types.ObjectId(String(input.patient));
  } else if (Object.hasOwn(input, 'patient')) {
    throw managementError('Only patient accounts may be linked to a Patient record');
  }

  const phone = normalizeText(input.phone, 'Phone number', 30, 1, false);
  return {
    fullName,
    username,
    password: input.password,
    role,
    ...(patientId ? { patient: patientId } : {}),
    ...(phone ? { phone } : {}),
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey)
  };
}

function serializeManagedUser(user) {
  return {
    id: user._id.toString(),
    fullName: user.fullName,
    username: user.username,
    role: user.role,
    ...(user.patient ? { patient: user.patient.toString() } : {}),
    isActive: user.isActive === true,
    ...(user.createdAt ? { createdAt: user.createdAt } : {}),
    ...(user.updatedAt ? { updatedAt: user.updatedAt } : {})
  };
}

async function loadUserWithPassword(userId) {
  try {
    return await User.findById(String(userId)).select('+password').lean();
  } catch (_) {
    throw managementError('Unable to verify an existing account', 500);
  }
}

async function sameProvisionedAccount(existing, input) {
  if (!existing ||
      existing.fullName !== input.fullName ||
      existing.username !== input.username ||
      existing.role !== input.role ||
      String(existing.patient || '') !== String(input.patient || '') ||
      (existing.phone || undefined) !== input.phone) {
    return false;
  }
  try {
    return await comparePassword(input.password, existing.password);
  } catch (_) {
    return false;
  }
}

async function findExistingByUsername(username) {
  try {
    return await User.findOne({ username }).select('_id').lean();
  } catch (_) {
    throw managementError('Unable to check for an existing username', 500);
  }
}

async function findExistingPatientAccount(patientId) {
  try {
    return await User.findOne({ patient: patientId }).select('_id').lean();
  } catch (_) {
    throw managementError('Unable to check for an existing patient portal account', 500);
  }
}

async function findAudit(actorId, action, entityId, idempotencyHash, partialSuccess = false) {
  const filter = { actor: actorId, action, entityType: 'User', entityId };
  if (idempotencyHash) {
    // The second value reads legacy hexadecimal audit entries written before
    // the safe alphabet was introduced.
    filter['details.idempotencyHash'] = {
      $in: [idempotencyHash, encodeAuditDigest(idempotencyHash)]
    };
  }
  try {
    return await AuditLog.findOne(filter).select('_id details').lean();
  } catch (_) {
    if (partialSuccess) {
      throw managementError('Account change may have been saved, but its audit state could not be verified', 503, {
        partialSuccess: true,
        userId: String(entityId)
      });
    }
    throw managementError('Unable to verify account audit state', 503);
  }
}

async function withAuditLock(key, operation) {
  const existing = auditOperations.get(key);
  if (existing) return existing;
  const pending = Promise.resolve().then(operation);
  auditOperations.set(key, pending);
  try {
    return await pending;
  } finally {
    if (auditOperations.get(key) === pending) auditOperations.delete(key);
  }
}

async function withStatusOperationLock(key, operation) {
  const existing = statusOperations.get(key);
  if (existing) return existing;
  const pending = Promise.resolve().then(operation);
  statusOperations.set(key, pending);
  try {
    return await pending;
  } finally {
    if (statusOperations.get(key) === pending) statusOperations.delete(key);
  }
}

async function ensureCreationAudit(adminId, userId, role, idempotencyHash) {
  const lockKey = `create:${userId}:${idempotencyHash}`;
  return withAuditLock(lockKey, async () => {
    const existing = await findAudit(adminId, 'user_created', userId, idempotencyHash, true);
    if (existing) return;
    try {
      await writeAuditLog({
        actorId: adminId,
        action: 'user_created',
        entityType: 'User',
        entityId: userId,
        details: {
          ...(role !== 'patient' ? { role } : {}),
          portalAccount: role === 'patient',
          idempotencyHash: encodeAuditDigest(idempotencyHash)
        }
      });
    } catch (_) {
      throw managementError(
        'The account was created, but audit logging failed. Retry with the same idempotencyKey to repair the audit without creating another account.',
        503,
        { partialSuccess: true, userId: String(userId) }
      );
    }
  });
}

function creationResult(user, replayed) {
  return { ...serializeManagedUser(user), ...(replayed ? { replayed: true } : {}) };
}

async function createManagedUser(input, adminUser) {
  const admin = await requireActiveAdmin(adminUser);
  const normalized = normalizeCreateInput(input);

  if (normalized.patient) {
    let patient;
    try {
      patient = await Patient.findById(String(normalized.patient)).select('_id').lean();
    } catch (_) {
      throw managementError('Unable to verify Patient record', 500);
    }
    if (!patient) throw managementError('Patient not found', 404);
  }

  const accountId = deterministicUserId(admin.id, normalized.idempotencyKey);
  const idempotencyHash = digest(`managed-user:${admin.id}:${normalized.idempotencyKey}`);
  const existing = await loadUserWithPassword(accountId);
  if (existing) {
    if (!(await sameProvisionedAccount(existing, normalized))) {
      throw managementError('This idempotencyKey was already used for different account data', 409);
    }
    await ensureCreationAudit(admin.id, existing._id, existing.role, idempotencyHash);
    return creationResult(existing, true);
  }

  const usernameOwner = await findExistingByUsername(normalized.username);
  if (usernameOwner) throw managementError('Username already exists', 409);
  if (normalized.patient) {
    const linkedAccount = await findExistingPatientAccount(normalized.patient);
    if (linkedAccount) throw managementError('This Patient already has a portal account', 409);
  }

  let created;
  try {
    created = await createUser({
      _id: accountId,
      fullName: normalized.fullName,
      username: normalized.username,
      password: normalized.password,
      role: normalized.role,
      ...(normalized.patient ? { patient: normalized.patient } : {}),
      ...(normalized.phone ? { phone: normalized.phone } : {})
    });
  } catch (error) {
    if (error.status === 409) {
      const raced = await loadUserWithPassword(accountId);
      if (raced && await sameProvisionedAccount(raced, normalized)) {
        await ensureCreationAudit(admin.id, raced._id, raced.role, idempotencyHash);
        return creationResult(raced, true);
      }
      throw managementError(
        normalized.patient ? 'Username or patient portal account already exists' : 'Username already exists',
        409
      );
    }
    if (error.status === 400 || error instanceof TypeError || error instanceof RangeError) {
      throw managementError('User account data is invalid; password must meet the configured password rules', 400);
    }
    throw managementError('Unable to create user account', 500);
  }

  const safeCreated = {
    _id: new mongoose.Types.ObjectId(String(created.id || created._id)),
    fullName: created.fullName,
    username: created.username,
    role: created.role,
    ...(created.patient ? { patient: created.patient } : {}),
    isActive: created.isActive,
    createdAt: created.createdAt,
    updatedAt: created.updatedAt
  };

  await ensureCreationAudit(admin.id, accountId, normalized.role, idempotencyHash);
  return creationResult(safeCreated, false);
}

function parsePositiveInteger(value, field, fallback, maximum) {
  if (value === undefined) return fallback;
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d+$/.test(text)) {
    throw managementError(`${field} must be a positive whole number`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw managementError(`${field} must be between 1 and ${maximum}`);
  }
  return parsed;
}

async function getManagedUser(userId, adminUser) {
  await requireActiveAdmin(adminUser);
  if (!validObjectId(userId)) throw managementError('A valid user ID is required');
  let user;
  try {
    user = await User.findById(String(userId))
      .select('_id fullName username role patient isActive createdAt updatedAt')
      .lean();
  } catch (_) {
    throw managementError('Unable to retrieve user account', 500);
  }
  if (!user) throw managementError('User not found', 404);
  return serializeManagedUser(user);
}

async function listManagedUsers(options, adminUser) {
  await requireActiveAdmin(adminUser);
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) {
    throw managementError('User list options must be an object');
  }
  const query = options || {};
  rejectUnknownFields(query, new Set(['page', 'limit']), 'User list options');
  const page = parsePositiveInteger(query.page, 'Page', 1, MAX_PAGE_NUMBER);
  const limit = parsePositiveInteger(query.limit, 'Limit', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const filter = {};
  const skip = (page - 1) * limit;

  let users;
  let total;
  try {
    [users, total] = await Promise.all([
      User.find(filter)
        .select('_id fullName username role patient isActive createdAt updatedAt')
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter)
    ]);
  } catch (_) {
    throw managementError('Unable to retrieve user accounts', 500);
  }
  return {
    users: users.map(serializeManagedUser),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  };
}

async function statusAuditExists(adminId, userId, idempotencyHash, requestedStatus, partialSuccess = false) {
  const existing = await findAudit(adminId, 'user_status_changed', userId, idempotencyHash, partialSuccess);
  if (existing && existing.details?.isActive !== requestedStatus) {
    throw managementError('This idempotencyKey was already used for a different status change', 409);
  }
  return existing;
}

async function ensureStatusAudit(adminId, userId, requestedStatus, idempotencyHash) {
  const lockKey = `status:${userId}:${idempotencyHash}`;
  return withAuditLock(lockKey, async () => {
    const existing = await statusAuditExists(adminId, userId, idempotencyHash, requestedStatus, true);
    if (existing) {
      pendingStatusAudits.delete(lockKey);
      return;
    }
    try {
      await writeAuditLog({
        actorId: adminId,
        action: 'user_status_changed',
        entityType: 'User',
        entityId: userId,
        details: { isActive: requestedStatus, idempotencyHash: encodeAuditDigest(idempotencyHash) }
      });
      pendingStatusAudits.delete(lockKey);
    } catch (_) {
      pendingStatusAudits.set(lockKey, { adminId, userId, requestedStatus, idempotencyHash });
      throw managementError(
        'The account status was changed, but audit logging failed. Retry with the same idempotencyKey to repair the audit.',
        503,
        { partialSuccess: true, userId: String(userId) }
      );
    }
  });
}

async function updateManagedUserStatusOperation(input, adminUser) {
  const admin = await requireActiveAdmin(adminUser);
  requireObject(input, 'User status input');
  rejectUnknownFields(input, new Set(['userId', 'isActive', 'idempotencyKey']), 'User status input');
  if (!validObjectId(input.userId)) throw managementError('A valid user ID is required');
  if (typeof input.isActive !== 'boolean') throw managementError('isActive must be a boolean');
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const userId = new mongoose.Types.ObjectId(String(input.userId));
  if (String(userId) === admin.id && input.isActive === false) {
    throw managementError('Administrators cannot deactivate their own account', 403);
  }

  const idempotencyHash = digest(`user-status:${admin.id}:${userId}:${idempotencyKey}`);
  const priorAudit = await statusAuditExists(admin.id, userId, idempotencyHash, input.isActive);
  if (priorAudit) {
    const current = await getUserStatusRecord(userId);
    if (!current) throw managementError('User not found', 404);
    if (current.isActive !== input.isActive) {
      throw managementError('This status change was already applied and later changed; use a new idempotencyKey', 409);
    }
    return { ...serializeManagedUser(current), replayed: true };
  }

  const lockKey = `status:${userId}:${idempotencyHash}`;
  const pending = pendingStatusAudits.get(lockKey);
  const before = await getUserStatusRecord(userId);
  if (!before) throw managementError('User not found', 404);
  if (typeof before.isActive !== 'boolean') {
    throw managementError('User account has an invalid status and cannot be changed safely', 409);
  }
  if (before.isActive === input.isActive) {
    if (pending && pending.requestedStatus === input.isActive) {
      await ensureStatusAudit(admin.id, userId, input.isActive, idempotencyHash);
    }
    return { ...serializeManagedUser(before), replayed: true };
  }

  let updated;
  try {
    updated = await User.findOneAndUpdate(
      { _id: userId, isActive: before.isActive },
      { $set: { isActive: input.isActive } },
      { new: true, runValidators: true }
    ).select('_id fullName username role patient isActive createdAt updatedAt').lean();
  } catch (error) {
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      throw managementError('User status is invalid', 400);
    }
    throw managementError('Unable to update user status', 500);
  }
  if (!updated) {
    const current = await getUserStatusRecord(userId);
    if (!current) throw managementError('User not found', 404);
    if (current.isActive === input.isActive) {
      return { ...serializeManagedUser(current), replayed: true };
    }
    throw managementError('User status changed concurrently; retry the operation', 409);
  }

  pendingStatusAudits.set(lockKey, {
    adminId: admin.id,
    userId: updated._id,
    requestedStatus: input.isActive,
    idempotencyHash
  });
  await ensureStatusAudit(admin.id, updated._id, input.isActive, idempotencyHash);
  return serializeManagedUser(updated);
}

async function updateManagedUserStatus(input, adminUser) {
  const admin = await requireActiveAdmin(adminUser);
  requireObject(input, 'User status input');
  if (!validObjectId(input.userId)) throw managementError('A valid user ID is required');
  const key = normalizeIdempotencyKey(input.idempotencyKey);
  const normalizedUserId = new mongoose.Types.ObjectId(String(input.userId)).toString();
  const hash = digest(`user-status:${admin.id}:${normalizedUserId}:${key}`);
  return withStatusOperationLock(`${admin.id}:${normalizedUserId}:${hash}`, () => (
    updateManagedUserStatusOperation(input, adminUser)
  ));
}

async function getUserStatusRecord(userId) {
  try {
    return await User.findById(String(userId))
      .select('_id fullName username role patient isActive createdAt updatedAt')
      .lean();
  } catch (_) {
    throw managementError('Unable to retrieve user status', 500);
  }
}

module.exports = {
  createManagedUser,
  getManagedUser,
  listManagedUsers,
  updateManagedUserStatus
};
