const mongoose = require('mongoose');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');

const PAYMENT_AUDIT_ACTIONS = new Set(['payment_initiated', 'payment_status_changed']);
const DEDUPLICATED_AUDIT_ACTIONS = new Set([
  'patient_consent_granted',
  'patient_consent_revoked',
  'break_glass_activated'
]);
const DEDUPLICATED_AUDIT_ENTITIES = new Map([
  ['patient_consent_granted', 'Consent'],
  ['patient_consent_revoked', 'Consent'],
  ['break_glass_activated', 'BreakGlass']
]);
const STOCK_ADDITION_ACTION = 'inventory_stock_added';
const STOCK_ADDITION_ENTITY = 'Inventory';

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
  userAgent,
  paymentDeduplicationKey,
  patientRegistrationDeduplicationKey,
  allergyOverride
} = {}) {
  if (!mongoose.isObjectIdOrHexString(actorId)) {
    throw createServiceError('A valid audit actor ID is required', 400);
  }

  const normalizedAction = requiredText(action, 'Audit action', 120);
  const normalizedEntityType = requiredText(entityType, 'Audit entity type', 100);

  const isPaymentAudit = normalizedEntityType === 'Payment' && PAYMENT_AUDIT_ACTIONS.has(normalizedAction);
  const isPatientRegistrationAudit = normalizedEntityType === 'Patient' && normalizedAction === 'patient_registered';
  const isAllergyOverrideAudit = normalizedEntityType === 'Prescription' && normalizedAction === 'prescription_allergy_override';
  const isStockAdditionAudit = normalizedEntityType === STOCK_ADDITION_ENTITY && normalizedAction === STOCK_ADDITION_ACTION;
  const stockAdditionDeduplicationKey = details && typeof details === 'object' && !Array.isArray(details)
    ? details.stockAdditionDeduplicationKey
    : undefined;
  const isEventDeduplicated = DEDUPLICATED_AUDIT_ACTIONS.has(normalizedAction);
  if (isEventDeduplicated && normalizedEntityType !== DEDUPLICATED_AUDIT_ENTITIES.get(normalizedAction)) {
    throw createServiceError('Audit entity type is invalid for this action', 400);
  }
  if (isEventDeduplicated && !mongoose.isObjectIdOrHexString(entityId)) {
    throw createServiceError('A valid entity ID is required for this audit action', 400);
  }
  if (isPaymentAudit && paymentDeduplicationKey === undefined) {
    throw createServiceError('Payment audit deduplication key is required', 400);
  }
  if (isStockAdditionAudit && stockAdditionDeduplicationKey === undefined) {
    throw createServiceError('Stock addition audit deduplication key is required', 400);
  }
  if (isStockAdditionAudit &&
      (typeof details.operationHash !== 'string' || !/^[a-f0-9]{64}$/.test(details.operationHash))) {
    throw createServiceError('Stock addition audit operation fingerprint is invalid', 400);
  }
  if (stockAdditionDeduplicationKey !== undefined) {
    if (typeof stockAdditionDeduplicationKey !== 'string' || !/^[a-f0-9]{64}$/.test(stockAdditionDeduplicationKey)) {
      throw createServiceError('Stock addition audit deduplication key is invalid', 400);
    }
    if (!isStockAdditionAudit) {
      throw createServiceError('Stock addition deduplication keys are only valid for stock addition events', 400);
    }
  }
  if (paymentDeduplicationKey !== undefined) {
    if (typeof paymentDeduplicationKey !== 'string' || !/^[a-f0-9]{64}$/.test(paymentDeduplicationKey)) {
      throw createServiceError('Payment audit deduplication key is invalid', 400);
    }
    if (!isPaymentAudit) {
      throw createServiceError('Payment deduplication keys are only valid for payment audit events', 400);
    }
  }
  if (patientRegistrationDeduplicationKey !== undefined) {
    if (typeof patientRegistrationDeduplicationKey !== 'string' || !/^[a-f0-9]{64}$/.test(patientRegistrationDeduplicationKey)) {
      throw createServiceError('Patient registration audit deduplication key is invalid', 400);
    }
    if (!isPatientRegistrationAudit) {
      throw createServiceError('Patient registration deduplication keys are only valid for patient registration events', 400);
    }
  }
  if (isAllergyOverrideAudit && allergyOverride === undefined) {
    throw createServiceError('Prescription allergy override audit data is required', 400);
  }
  if (allergyOverride !== undefined) {
    const expectedKeys = ['patientId', 'prescriptionId', 'reason'];
    if (!isAllergyOverrideAudit || !allergyOverride || typeof allergyOverride !== 'object' || Array.isArray(allergyOverride) ||
        Object.keys(allergyOverride).some((key) => !expectedKeys.includes(key)) ||
        expectedKeys.some((key) => !Object.hasOwn(allergyOverride, key))) {
      throw createServiceError('Prescription allergy override audit data is invalid', 400);
    }
    if (!mongoose.isObjectIdOrHexString(allergyOverride.patientId) ||
        !mongoose.isObjectIdOrHexString(allergyOverride.prescriptionId)) {
      throw createServiceError('Prescription allergy override references are invalid', 400);
    }
    if (typeof allergyOverride.reason !== 'string' || allergyOverride.reason.trim().length < 20 || allergyOverride.reason.trim().length > 1000) {
      throw createServiceError('Prescription allergy override reason must contain 20 to 1000 characters', 400);
    }
    if (String(allergyOverride.prescriptionId) !== String(entityId)) {
      throw createServiceError('Prescription allergy override must reference its audit entity', 400);
    }
  }

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
    ...(paymentDeduplicationKey !== undefined ? { paymentDeduplicationKey } : {}),
    ...(patientRegistrationDeduplicationKey !== undefined ? { patientRegistrationDeduplicationKey } : {}),
    ...(allergyOverride !== undefined ? {
      allergyOverride: {
        patient: allergyOverride.patientId,
        prescription: allergyOverride.prescriptionId,
        reason: allergyOverride.reason.trim()
      }
    } : {}),
    ...(ipAddress != null ? { ipAddress } : {}),
    ...(userAgent != null ? { userAgent } : {})
  });

  try {
    await auditLog.save();
  } catch (error) {
    if (error.code === 11000 && (
      paymentDeduplicationKey !== undefined ||
      patientRegistrationDeduplicationKey !== undefined ||
      allergyOverride !== undefined ||
      isStockAdditionAudit ||
      DEDUPLICATED_AUDIT_ACTIONS.has(normalizedAction)
    )) {
      const isPatientRegistration = patientRegistrationDeduplicationKey !== undefined;
      const isAllergyOverride = allergyOverride !== undefined;
      const isStockAddition = isStockAdditionAudit;
      const filter = isEventDeduplicated
        ? { actor: actor._id, action: normalizedAction, entityType: normalizedEntityType, entityId }
        : isAllergyOverride
          ? { 'allergyOverride.prescription': allergyOverride.prescriptionId }
          : isStockAddition
            ? {
                actor: actor._id,
                action: normalizedAction,
                entityType: normalizedEntityType,
                entityId,
                'details.stockAdditionDeduplicationKey': stockAdditionDeduplicationKey
              }
          : isPatientRegistration
            ? { patientRegistrationDeduplicationKey }
            : { paymentDeduplicationKey };
      let existing;
      try {
        existing = await AuditLog.findOne(filter)
          .select(`_id actor action entityType entityId createdAt${isAllergyOverride ? ' +allergyOverride' : ''}${isStockAddition ? ' details.stockAdditionDeduplicationKey details.quantityAdded details.operationHash' : ''}`)
          .lean();
      } catch (_) {
        throw createServiceError('Unable to confirm the existing audit event', 503);
      }

      if (existing &&
          String(existing.actor) === String(actor._id) &&
          existing.action === normalizedAction &&
          existing.entityType === normalizedEntityType &&
          String(existing.entityId || '') === String(entityId || '') &&
          (!isAllergyOverride || (
            String(existing.allergyOverride?.patient || '') === String(allergyOverride.patientId) &&
            String(existing.allergyOverride?.prescription || '') === String(allergyOverride.prescriptionId) &&
            existing.allergyOverride?.reason === allergyOverride.reason.trim()
          )) &&
          (!isStockAddition || (
            existing.details?.stockAdditionDeduplicationKey === stockAdditionDeduplicationKey &&
            existing.details?.quantityAdded === details.quantityAdded &&
            existing.details?.operationHash === details.operationHash
          ))) {
        return {
          id: existing._id.toString(),
          actor: actor._id.toString(),
          action: normalizedAction,
          entityType: normalizedEntityType,
          ...(existing.entityId ? { entityId: existing.entityId.toString() } : {}),
          createdAt: existing.createdAt,
          deduplicated: true
        };
      }

      throw createServiceError(
        isAllergyOverride
          ? 'Prescription allergy override audit conflicts with an existing event'
          : isPatientRegistration
            ? 'Patient registration audit deduplication key conflicts with another event'
            : isEventDeduplicated
              ? 'A matching audit event already exists with conflicting values'
              : isStockAddition
                ? 'Stock addition audit key conflicts with an existing event'
              : 'Payment audit deduplication key conflicts with another event',
        409
      );
    }
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
