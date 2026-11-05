const crypto = require('node:crypto');
const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog');
const Department = require('../models/Department');
const Encounter = require('../models/Encounter');
const Patient = require('../models/Patient');
const Referral = require('../models/Referral');
const User = require('../models/User');
const { authorizePatientRecordAccess } = require('./patient-access.service');
const { writeAuditLog } = require('./audit-log.service');

const REFERRAL_CREATE_ACTION = 'referral_created';
const REFERRAL_STATUS_ACTION = 'referral_status_changed';
const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 100;
const MAX_LIST_WINDOW = 500;
const MIN_REASON_LENGTH = 10;
const STATUS_TRANSITIONS = {
  pending: new Set(['accepted', 'cancelled']),
  accepted: new Set(['completed', 'cancelled']),
  completed: new Set(),
  cancelled: new Set()
};
const auditWrites = new Map();
const pendingStatusAudits = new Map();

function referralError(message, status = 400, properties = {}) {
  const error = new Error(message);
  error.name = 'ReferralServiceError';
  error.status = status;
  error.statusCode = status;
  Object.assign(error, properties);
  return error;
}

function validObjectId(value) {
  return mongoose.isObjectIdOrHexString(value);
}

function rejectUnknownFields(input, allowed, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw referralError(`${label} must be an object`);
  }
  if (Object.keys(input).some((field) => !allowed.has(field))) {
    throw referralError(`${label} contains unsupported or server-managed fields`);
  }
}

function normalizeText(value, field, maximumLength, required = false) {
  if (value === undefined || value === null) {
    if (required) throw referralError(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw referralError(`${field} must be text`);
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if ((required && !normalized) || normalized.length > maximumLength) {
    throw referralError(`${field} is invalid`);
  }
  return normalized || undefined;
}

function parsePositiveInteger(value, field, fallback, maximum) {
  if (value === undefined) return fallback;
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d+$/.test(text)) {
    throw referralError(`${field} must be a positive whole number`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw referralError(`${field} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function normalizeIdempotencyKey(value) {
  const key = normalizeText(value, 'idempotencyKey', 128, true);
  if (key.length < 8) throw referralError('idempotencyKey must contain between 8 and 128 characters');
  return key;
}

function hashValue(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function referralIdFor(doctorId, encounterId, key) {
  const bytes = crypto.createHash('sha256')
    .update(`referral:${doctorId}:${encounterId}:${key}`)
    .digest()
    .subarray(0, 12);
  return new mongoose.Types.ObjectId(bytes);
}

async function requireActiveUser(user, allowedRoles) {
  if (!user || typeof user !== 'object' || !validObjectId(user.id)) {
    throw referralError('Authentication required', 401);
  }
  let currentUser;
  try {
    currentUser = await User.findById(String(user.id)).select('_id role patient isActive').lean();
  } catch (_) {
    throw referralError('Unable to verify authenticated user', 500);
  }
  if (!currentUser || currentUser.isActive !== true) throw referralError('Authentication required', 401);
  if (!allowedRoles.includes(currentUser.role)) {
    throw referralError('This user role cannot access referral records', 403);
  }
  return {
    _id: currentUser._id,
    id: currentUser._id.toString(),
    role: currentUser.role,
    ...(currentUser.patient ? { patient: currentUser.patient } : {})
  };
}

async function loadEncounter(encounterId, expectedPatientId) {
  if (!validObjectId(encounterId)) throw referralError('A valid encounter ID is required');
  let encounter;
  try {
    encounter = await Encounter.findById(String(encounterId)).select('_id patient').lean();
  } catch (_) {
    throw referralError('Unable to retrieve encounter', 500);
  }
  if (!encounter) throw referralError('Encounter not found', 404);
  if (!validObjectId(encounter.patient)) throw referralError('Encounter patient reference is invalid', 409);
  if (expectedPatientId && String(encounter.patient) !== String(expectedPatientId)) {
    throw referralError('Encounter does not belong to the requested patient', 400);
  }
  let patientExists;
  try {
    patientExists = await Patient.exists({ _id: encounter.patient });
  } catch (_) {
    throw referralError('Unable to verify encounter patient', 500);
  }
  if (!patientExists) throw referralError('Encounter patient was not found', 404);
  return encounter;
}

async function authorizeReferralAccess(user, patientId, encounterId) {
  let access;
  try {
    access = await authorizePatientRecordAccess(user, String(patientId), String(encounterId));
  } catch (_) {
    throw referralError('Unable to authorize or audit patient-record access', 500);
  }
  if (!access.allowed) {
    throw referralError(access.message || 'Access to this referral is not permitted', access.statusCode || 403);
  }
}

async function resolveActiveDepartment(value) {
  const requested = normalizeText(value, 'Receiving department', 200, true);
  let department;
  try {
    department = await Department.findOne({
      isActive: true,
      $or: [{ name: requested }, { code: requested.toUpperCase() }]
    }).select('_id name code').lean();
  } catch (_) {
    throw referralError('Unable to verify receiving department', 500);
  }
  if (!department) throw referralError('Active receiving department was not found', 404);
  return department.name;
}

function serializeReferral(referral, replayed = false) {
  return {
    id: referral._id.toString(),
    patient: referral.patient.toString(),
    encounter: referral.encounter.toString(),
    referringDoctor: referral.referringDoctor.toString(),
    receivingHospital: referral.receivingHospital,
    ...(referral.specialist ? { specialist: referral.specialist } : {}),
    reason: referral.reason,
    ...(referral.clinicalSummary ? { clinicalSummary: referral.clinicalSummary } : {}),
    status: referral.status,
    referredAt: referral.referredAt,
    createdAt: referral.createdAt,
    updatedAt: referral.updatedAt,
    ...(replayed ? { replayed: true } : {})
  };
}

function sameReferral(referral, input) {
  return String(referral.encounter) === input.encounterId &&
    String(referral.referringDoctor) === input.doctorId &&
    referral.receivingHospital === input.receivingHospital &&
    (referral.specialist || undefined) === input.specialist &&
    referral.reason === input.reason &&
    (referral.clinicalSummary || undefined) === input.clinicalSummary;
}

async function auditExists(actorId, action, entityId, operationHash) {
  const filter = { actor: actorId, action, entityType: 'Referral', entityId };
  if (operationHash) filter['details.operationHash'] = operationHash;
  try {
    return await AuditLog.findOne(filter).select('_id').lean();
  } catch (_) {
    throw referralError('Referral may have been saved, but audit state could not be verified', 503, {
      partialSuccess: true,
      referralId: String(entityId)
    });
  }
}

async function ensureAudit(actorId, action, entityId, details, operationHash) {
  const key = `${actorId}:${action}:${entityId}:${operationHash || ''}`;
  if (auditWrites.has(key)) return auditWrites.get(key);
  const write = (async () => {
    const existing = await auditExists(actorId, action, entityId, operationHash);
    if (existing) return;
    try {
      await writeAuditLog({
        actorId,
        action,
        entityType: 'Referral',
        entityId,
        ...(details ? { details } : {})
      });
    } catch (_) {
      throw referralError('Referral operation was saved, but audit logging failed. Check the referral record before retrying.', 503, {
        partialSuccess: true,
        referralId: String(entityId)
      });
    }
  })();
  auditWrites.set(key, write);
  try {
    await write;
  } finally {
    if (auditWrites.get(key) === write) auditWrites.delete(key);
  }
}

async function getReferralById(id) {
  try {
    return await Referral.findById(String(id)).lean();
  } catch (_) {
    throw referralError('Unable to retrieve referral', 500);
  }
}

async function verifyReferralRelations(referral) {
  if (!validObjectId(referral.patient) || !validObjectId(referral.encounter)) {
    throw referralError('Referral references are invalid', 409);
  }
  const encounter = await loadEncounter(referral.encounter, referral.patient);
  return { patientId: String(encounter.patient), encounterId: String(encounter._id) };
}

async function createReferral(input, user) {
  rejectUnknownFields(
    input,
    new Set(['encounterId', 'receivingHospital', 'specialist', 'reason', 'clinicalSummary', 'idempotencyKey']),
    'Referral input'
  );
  const doctor = await requireActiveUser(user, ['doctor']);
  if (!validObjectId(input.encounterId)) throw referralError('A valid encounter ID is required');
  const reason = normalizeText(input.reason, 'Referral reason', 2000, true);
  if (reason.length < MIN_REASON_LENGTH) {
    throw referralError(`Referral reason must contain at least ${MIN_REASON_LENGTH} characters`);
  }
  const specialist = normalizeText(input.specialist, 'Specialist', 150);
  const clinicalSummary = normalizeText(input.clinicalSummary, 'Clinical summary', 5000);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const encounter = await loadEncounter(input.encounterId);
  const encounterId = String(encounter._id);
  const patientId = String(encounter.patient);
  await authorizeReferralAccess(doctor, patientId, encounterId);
  const receivingHospital = await resolveActiveDepartment(input.receivingHospital);
  const normalized = {
    encounterId,
    doctorId: doctor._id.toString(),
    receivingHospital,
    specialist,
    reason,
    clinicalSummary
  };
  const referralId = referralIdFor(normalized.doctorId, encounterId, idempotencyKey);
  const operationHash = hashValue(`${normalized.doctorId}:${encounterId}:${idempotencyKey}`);

  let existing = await getReferralById(referralId);
  if (existing) {
    if (!sameReferral(existing, normalized)) {
      throw referralError('This idempotencyKey was already used for a different referral', 409);
    }
    await ensureAudit(doctor._id, REFERRAL_CREATE_ACTION, existing._id, { operationHash }, operationHash);
    return serializeReferral(existing, true);
  }

  let referral;
  try {
    referral = await Referral.create({
      _id: referralId,
      patient: encounter.patient,
      encounter: encounter._id,
      referringDoctor: doctor._id,
      receivingHospital,
      ...(specialist ? { specialist } : {}),
      reason,
      ...(clinicalSummary ? { clinicalSummary } : {}),
      status: 'pending',
      referredAt: new Date()
    });
  } catch (error) {
    if (error.code === 11000) {
      existing = await getReferralById(referralId);
      if (existing && sameReferral(existing, normalized)) {
        await ensureAudit(doctor._id, REFERRAL_CREATE_ACTION, existing._id, { operationHash }, operationHash);
        return serializeReferral(existing, true);
      }
      throw referralError('Referral could not be created safely', 409);
    }
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      throw referralError('Referral data is invalid', 400);
    }
    throw referralError('Unable to create referral', 500);
  }

  await ensureAudit(doctor._id, REFERRAL_CREATE_ACTION, referral._id, { operationHash }, operationHash);
  return serializeReferral(referral);
}

async function listReferrals(options = {}, user) {
  rejectUnknownFields(options, new Set(['encounterId', 'page', 'limit']), 'Referral list options');
  const actor = await requireActiveUser(user, ['patient', 'doctor']);
  const page = parsePositiveInteger(options.page, 'Page', 1, MAX_PAGE);
  const limit = parsePositiveInteger(options.limit, 'Limit', 20, MAX_PAGE_SIZE);
  const offset = (page - 1) * limit;
  const scanLimit = offset + limit + 1;
  if (scanLimit > MAX_LIST_WINDOW) throw referralError(`Requested page exceeds the maximum referral list window of ${MAX_LIST_WINDOW}`);

  let patientId;
  let encounterFilter;
  if (actor.role === 'patient') {
    if (!validObjectId(actor.patient)) throw referralError('Patient account is not linked to a valid patient record', 403);
    patientId = actor.patient;
    let patientExists;
    try {
      patientExists = await Patient.exists({ _id: patientId });
    } catch (_) {
      throw referralError('Unable to verify linked patient record', 500);
    }
    if (!patientExists) throw referralError('Patient account is not linked to an existing patient record', 403);
    if (options.encounterId !== undefined) {
      const encounter = await loadEncounter(options.encounterId, patientId);
      encounterFilter = encounter._id;
      await authorizeReferralAccess(actor, patientId, encounter._id);
    } else {
      let access;
      try {
        access = await authorizePatientRecordAccess(actor, String(patientId));
      } catch (_) {
        throw referralError('Unable to authorize or audit patient-record access', 500);
      }
      if (!access.allowed) throw referralError(access.message || 'Access to referrals is not permitted', access.statusCode || 403);
    }
  } else {
    if (!validObjectId(options.encounterId)) {
      throw referralError('Doctors must provide a valid encounterId to list referrals');
    }
    const encounter = await loadEncounter(options.encounterId);
    patientId = encounter.patient;
    encounterFilter = encounter._id;
    await authorizeReferralAccess(actor, patientId, encounter._id);
  }

  const filter = { patient: patientId };
  if (encounterFilter) filter.encounter = encounterFilter;
  let referrals;
  try {
    referrals = await Referral.find(filter)
      .select('_id patient encounter referringDoctor receivingHospital specialist reason clinicalSummary status referredAt createdAt updatedAt')
      .sort({ referredAt: -1, _id: -1 })
      .limit(scanLimit)
      .lean();
  } catch (_) {
    throw referralError('Unable to retrieve referrals', 500);
  }
  if (referrals.length >= MAX_LIST_WINDOW && scanLimit > MAX_LIST_WINDOW) {
    throw referralError('Referral list exceeds the supported page window', 413);
  }

  const encounterIds = [...new Set(referrals.map((referral) => String(referral.encounter)))];
  let validEncounters = [];
  if (encounterIds.length > 0) {
    try {
      validEncounters = await Encounter.find({ _id: { $in: encounterIds }, patient: patientId })
        .select('_id')
        .lean();
    } catch (_) {
      throw referralError('Unable to verify referral encounter relationships', 500);
    }
  }
  const validIds = new Set(validEncounters.map((encounter) => String(encounter._id)));
  const safeReferrals = referrals.filter((referral) => (
    String(referral.patient) === String(patientId) && validIds.has(String(referral.encounter))
  ));
  return {
    referrals: safeReferrals.slice(offset, offset + limit).map((referral) => serializeReferral(referral)),
    pagination: { page, limit, hasMore: safeReferrals.length > offset + limit }
  };
}

async function getReferralDetails(referralId, user) {
  if (!validObjectId(referralId)) throw referralError('A valid referral ID is required');
  const actor = await requireActiveUser(user, ['patient', 'doctor']);
  const referral = await getReferralById(referralId);
  if (!referral) throw referralError('Referral not found', 404);
  const relations = await verifyReferralRelations(referral);

  if (actor.role === 'patient' &&
      (!validObjectId(actor.patient) || String(actor.patient) !== relations.patientId)) {
    throw referralError('Referral not found', 404);
  }
  await authorizeReferralAccess(actor, relations.patientId, relations.encounterId);
  return serializeReferral(referral);
}

async function updateReferralStatus(input, user) {
  rejectUnknownFields(input, new Set(['referralId', 'status', 'idempotencyKey']), 'Referral status input');
  if (!validObjectId(input.referralId)) throw referralError('A valid referral ID is required');
  if (!['accepted', 'completed', 'cancelled'].includes(input.status)) {
    throw referralError('Referral status must be accepted, completed, or cancelled');
  }
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const doctor = await requireActiveUser(user, ['doctor']);
  const referral = await getReferralById(input.referralId);
  if (!referral) throw referralError('Referral not found', 404);
  if (String(referral.referringDoctor) !== String(doctor._id)) {
    throw referralError('Only the referring doctor may update this referral status', 403);
  }
  const relations = await verifyReferralRelations(referral);
  await authorizeReferralAccess(doctor, relations.patientId, relations.encounterId);

  const operationHash = hashValue(`${doctor._id}:${referral._id}:${idempotencyKey}:${input.status}`);
  if (referral.status === input.status) {
    const existingAudit = await auditExists(doctor._id, REFERRAL_STATUS_ACTION, referral._id, operationHash);
    if (existingAudit) return { ...serializeReferral(referral), replayed: true };
    const pending = pendingStatusAudits.get(operationHash);
    if (pending) {
      await ensureAudit(
        doctor._id,
        REFERRAL_STATUS_ACTION,
        referral._id,
        { fromStatus: pending.fromStatus, toStatus: pending.toStatus, operationHash },
        operationHash
      );
      pendingStatusAudits.delete(operationHash);
      return { ...serializeReferral(referral), replayed: true };
    }
    throw referralError(
      'Referral already has this status. The schema cannot confirm whether this request changed it; verify audit history before retrying.',
      409
    );
  }
  if (!STATUS_TRANSITIONS[referral.status]?.has(input.status)) {
    throw referralError(`Referral cannot transition from ${referral.status} to ${input.status}`, 409);
  }

  let updated;
  try {
    updated = await Referral.findOneAndUpdate(
      { _id: referral._id, referringDoctor: doctor._id, status: referral.status },
      { $set: { status: input.status } },
      { new: true, runValidators: true }
    ).lean();
  } catch (error) {
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      throw referralError('Referral status is invalid', 400);
    }
    throw referralError('Unable to update referral status', 500);
  }
  if (!updated) throw referralError('Referral status changed concurrently; reload the referral before retrying', 409);

  const auditDetails = { fromStatus: referral.status, toStatus: input.status, operationHash };
  pendingStatusAudits.set(operationHash, auditDetails);
  await ensureAudit(doctor._id, REFERRAL_STATUS_ACTION, updated._id, auditDetails, operationHash);
  pendingStatusAudits.delete(operationHash);
  return serializeReferral(updated);
}

module.exports = {
  createReferral,
  listReferrals,
  getReferralDetails,
  updateReferralStatus
};
