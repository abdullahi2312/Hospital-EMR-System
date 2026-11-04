const mongoose = require('mongoose');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');

function createServiceError(message, status) {
  const error = new Error(message);
  error.name = 'AuditLogServiceError';
  error.status = status;
  error.statusCode = status;
  return error;
}

function requiredText(value, fieldName, maximumLength) {
  if (typeof value !== 'string') {
    throw createServiceError(`${fieldName} is required`, 400);
  }

  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw createServiceError(`${fieldName} must be between 1 and ${maximumLength} characters`, 400);
  }

  return normalized;
}

async function writeAuditLog({
  actorId,
  action,
  entityType,
  entityId,
  details,
  ipAddress,
  userAgent
} = {}) {
  if (!mongoose.isObjectIdOrHexString(actorId)) {
    throw createServiceError('A valid audit actor ID is required', 400);
  }

  const normalizedAction = requiredText(action, 'Audit action', 120);
  const normalizedEntityType = requiredText(entityType, 'Audit entity type', 100);

  if (entityId !== undefined && entityId !== null && !mongoose.isObjectIdOrHexString(entityId)) {
    throw createServiceError('A valid audit entity ID is required', 400);
  }

  if (ipAddress !== undefined && ipAddress !== null && typeof ipAddress !== 'string') {
    throw createServiceError('IP address must be text', 400);
  }
  if (userAgent !== undefined && userAgent !== null && typeof userAgent !== 'string') {
    throw createServiceError('User agent must be text', 400);
  }

  let actor;
  try {
    actor = await User.findById(String(actorId)).select('_id').lean();
  } catch (_) {
    throw createServiceError('Unable to verify audit actor', 500);
  }

  if (!actor) {
    throw createServiceError('Audit actor does not exist', 404);
  }

  const auditLog = new AuditLog({
    actor: actor._id,
    action: normalizedAction,
    entityType: normalizedEntityType,
    ...(entityId != null ? { entityId } : {}),
    ...(details !== undefined ? { details } : {}),
    ...(ipAddress != null ? { ipAddress } : {}),
    ...(userAgent != null ? { userAgent } : {})
  });

  try {
    await auditLog.save();
  } catch (error) {
    if (error.name === 'ValidationError' || error.name === 'StrictModeError' || error.name === 'CastError') {
      throw createServiceError('Audit log data is invalid', 400);
    }
    throw createServiceError('Unable to write audit log', 500);
  }

  return {
    id: auditLog._id.toString(),
    actor: actor._id.toString(),
    action: auditLog.action,
    entityType: auditLog.entityType,
    ...(auditLog.entityId ? { entityId: auditLog.entityId.toString() } : {}),
    createdAt: auditLog.createdAt
  };
}

module.exports = {
  writeAuditLog
};
