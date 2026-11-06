const crypto = require('node:crypto');
const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog');
const AccessLog = require('../models/AccessLog');
const Department = require('../models/Department');
const Encounter = require('../models/Encounter');
const Patient = require('../models/Patient');
const User = require('../models/User');
const { authorizePatientRecordAccess } = require('./patient-access.service');
const { writeAuditLog } = require('./audit-log.service');

const SEQUENCE_ID = 'encounter_visit_sequence';
const VISIT_NUMBER_PATTERN = /^VISIT-(\d{6})$/;
const MAX_SEQUENCE = 999999;
const MAX_PAGE = 1000000;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const SUMMARY_FIELDS = '_id patient visitNumber department assignedDoctor status visitType openedAt closedAt createdAt updatedAt';

function encounterError(message, status = 400, properties = {}) {
  const error = new Error(message);
  error.name = 'EncounterServiceError';
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
    throw encounterError(`${label} must be an object`);
  }
}

function rejectUnknownFields(input, allowed, label) {
  if (Object.keys(input).some((field) => !allowed.has(field))) {
    throw encounterError(`${label} contains unsupported or server-managed fields`);
  }
}

function normalizeText(value, field, maximumLength, required = false) {
  if (value === undefined || value === null) {
    if (required) throw encounterError(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw encounterError(`${field} must be text`);
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if ((required && normalized.length === 0) || normalized.length > maximumLength) {
    throw encounterError(`${field} is invalid`);
  }
  return normalized || undefined;
}

function normalizeIdempotencyKey(value) {
  const key = normalizeText(value, 'idempotencyKey', 128, true);
  if (key.length < 8) {
    throw encounterError('idempotencyKey must contain between 8 and 128 characters');
  }
  return key;
}

function deterministicId(scope, values) {
  const bytes = crypto.createHash('sha256').update(`${scope}:${values.join(':')}`).digest().subarray(0, 12);
  return new mongoose.Types.ObjectId(bytes);
}

function normalizeEncounterInput(input) {
  requireObject(input, 'Encounter input');
  rejectUnknownFields(input, new Set([
    'patient', 'department', 'visitType', 'chiefComplaint', 'idempotencyKey'
  ]), 'Encounter input');

  if (!validObjectId(input.patient)) throw encounterError('A valid patient ID is required');
  const department = normalizeText(input.department, 'Department', 100, true);
  const visitType = normalizeText(input.visitType, 'Visit type', 20, true).toLowerCase();
  if (!['outpatient', 'inpatient', 'emergency'].includes(visitType)) {
    throw encounterError('Visit type must be outpatient, inpatient, or emergency');
  }
  const chiefComplaint = normalizeText(input.chiefComplaint, 'Chief complaint', 2000);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);

  return {
    patientId: new mongoose.Types.ObjectId(String(input.patient)),
    department,
    visitType,
    chiefComplaint,
    idempotencyKey
  };
}

async function requireActiveUser(user, allowedRoles) {
  if (!user || typeof user !== 'object' || !validObjectId(user.id)) {
    throw encounterError('Authentication required', 401);
  }

  let currentUser;
  try {
    currentUser = await User.findById(String(user.id)).select('_id role patient isActive').lean();
  } catch (_) {
    throw encounterError('Unable to verify authenticated user', 500);
  }

  if (!currentUser || currentUser.isActive !== true) {
    throw encounterError('Authentication required', 401);
  }
  if (!allowedRoles.includes(currentUser.role)) {
    throw encounterError('This user role cannot perform this encounter operation', 403);
  }
  if (currentUser.role === 'patient' && !validObjectId(currentUser.patient)) {
    throw encounterError('Patient account is not linked to a valid Patient record', 403);
  }

  return {
    id: currentUser._id.toString(),
    role: currentUser.role,
    ...(currentUser.patient ? { patient: currentUser.patient.toString() } : {})
  };
}

async function nextVisitNumber() {
  const database = mongoose.connection.db;
  if (!database) throw encounterError('Database is not connected', 503);

  const counters = database.collection('hospital_emr_sequences');
  try {
    const current = await counters.findOne({ _id: SEQUENCE_ID });
    if (!current) {
      const latestEncounter = await Encounter.findOne({ visitNumber: /^VISIT-\d{6}$/ })
        .sort({ visitNumber: -1 })
        .select('visitNumber')
        .lean();
      const match = latestEncounter?.visitNumber?.match(VISIT_NUMBER_PATTERN);
      try {
        await counters.insertOne({ _id: SEQUENCE_ID, sequence: match ? Number(match[1]) : 0 });
      } catch (error) {
        if (error.code !== 11000) throw error;
      }
    }

    const result = await counters.findOneAndUpdate(
      { _id: SEQUENCE_ID },
      { $inc: { sequence: 1 } },
      { upsert: true, returnDocument: 'after', includeResultMetadata: false }
    );
    const updated = result?.value ?? result;
    if (!Number.isInteger(updated?.sequence) || updated.sequence < 1 || updated.sequence > MAX_SEQUENCE) {
      throw encounterError('Encounter visit number sequence is unavailable or exhausted', 503);
    }
    return `VISIT-${String(updated.sequence).padStart(6, '0')}`;
  } catch (error) {
    if (error.name === 'EncounterServiceError') throw error;
    throw encounterError('Unable to generate an encounter visit number', 500);
  }
}

async function requireExistingPatient(patientId) {
  let patient;
  try {
    patient = await Patient.findById(String(patientId)).select('_id').lean();
  } catch (_) {
    throw encounterError('Unable to verify patient', 500);
  }
  if (!patient) throw encounterError('Patient not found', 404);
  return patient;
}

async function resolveActiveDepartment(value) {
  let department;
  try {
    department = await Department.findOne({
      isActive: true,
      $or: [{ name: value }, { code: value.toUpperCase() }]
    }).select('_id name code').lean();
  } catch (_) {
    throw encounterError('Unable to verify department', 500);
  }
  if (!department) throw encounterError('Active department was not found', 404);
  return department.name;
}

function sameEncounterRequest(encounter, input) {
  return String(encounter.patient) === String(input.patientId) &&
    encounter.department === input.departmentName &&
    encounter.visitType === input.visitType &&
    (encounter.chiefComplaint || undefined) === input.chiefComplaint;
}

function serializeSummary(encounter) {
  return {
    id: encounter._id.toString(),
    patient: encounter.patient.toString(),
    visitNumber: encounter.visitNumber,
    department: encounter.department,
    ...(encounter.assignedDoctor ? { assignedDoctor: encounter.assignedDoctor.toString() } : {}),
    status: encounter.status,
    visitType: encounter.visitType,
    openedAt: encounter.openedAt,
    ...(encounter.closedAt ? { closedAt: encounter.closedAt } : {}),
    createdAt: encounter.createdAt,
    updatedAt: encounter.updatedAt
  };
}

async function auditExists(actorId, action, entityId, operationKey) {
  const filter = { actor: actorId, action, entityType: 'Encounter', entityId };
  if (operationKey) filter['details.operationKey'] = operationKey;
  try {
    return await AuditLog.findOne(filter).select('_id').lean();
  } catch (_) {
    throw encounterError('Encounter operation may have been saved, but audit state could not be verified', 503, {
      partialSuccess: true,
      encounterId: String(entityId)
    });
  }
}

async function ensureAudit(actorId, action, entityId, details, operationKey) {
  const existing = await auditExists(actorId, action, entityId, operationKey);
  if (existing) return;

  try {
    await writeAuditLog({
      actorId,
      action,
      entityType: 'Encounter',
      entityId,
      ...(details ? { details } : {})
    });
  } catch (_) {
    throw encounterError(
      'Encounter change was saved, but audit logging failed. Verify the encounter before retrying.',
      503,
      { partialSuccess: true, encounterId: String(entityId) }
    );
  }
}

function assignmentOperationKey(actorId, encounterId, idempotencyKey) {
  return crypto.createHash('sha256')
    .update(`encounter-assignment:${actorId}:${encounterId}:${idempotencyKey}`)
    .digest('hex');
}

async function authorizeEncounterRead(user, encounter) {
  let access;
  try {
    access = await authorizePatientRecordAccess(
      user,
      String(encounter.patient),
      String(encounter._id),
      'View encounter summary'
    );
  } catch (_) {
    throw encounterError('Unable to authorize or audit encounter access', 500);
  }
  if (!access.allowed) {
    throw encounterError(access.message || 'Access to this encounter is not permitted', access.statusCode || 403);
  }
}

async function recordEncounterVisibilityDenial(user, encounter) {
  try {
    await AccessLog.create({
      patient: encounter.patient,
      user: user.id,
      encounter: encounter._id,
      action: 'denied_access',
      accessMethod: 'denied',
      accessReason: 'View encounter summary'
    });
  } catch (_) {
    throw encounterError('Unable to record encounter access denial', 500);
  }
}

function parsePositiveInteger(value, field, fallback, maximum) {
  if (value === undefined) return fallback;
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d+$/.test(text)) {
    throw encounterError(`${field} must be a positive whole number`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw encounterError(`${field} must be between 1 and ${maximum}`);
  }
  return parsed;
}

async function createEncounter(input, user) {
  const actor = await requireActiveUser(user, ['receptionist', 'admin']);
  const normalized = normalizeEncounterInput(input);
  await requireExistingPatient(normalized.patientId);
  const departmentName = await resolveActiveDepartment(normalized.department);
  const encounterId = deterministicId('encounter-create', [actor.id, normalized.idempotencyKey]);
  const normalizedForMatch = { ...normalized, departmentName };

  let existing;
  try {
    existing = await Encounter.findById(encounterId).lean();
  } catch (_) {
    throw encounterError('Unable to check for a previous encounter submission', 500);
  }
  if (existing) {
    if (!sameEncounterRequest(existing, normalizedForMatch)) {
      throw encounterError('This idempotencyKey was already used for a different encounter', 409);
    }
    await ensureAudit(actor.id, 'encounter_created', existing._id, undefined, undefined);
    return { ...serializeSummary(existing), replayed: true };
  }

  const encounter = new Encounter({
    _id: encounterId,
    patient: normalized.patientId,
    visitNumber: await nextVisitNumber(),
    department: departmentName,
    visitType: normalized.visitType,
    ...(normalized.chiefComplaint ? { chiefComplaint: normalized.chiefComplaint } : {}),
    status: 'open',
    openedAt: new Date()
  });

  let saved;
  try {
    saved = await encounter.save();
  } catch (error) {
    if (error.code === 11000) {
      let raced;
      try {
        raced = await Encounter.findById(encounterId).lean();
      } catch (_) {
        throw encounterError('Unable to verify encounter submission', 500);
      }
      if (raced && sameEncounterRequest(raced, normalizedForMatch)) {
        await ensureAudit(actor.id, 'encounter_created', raced._id, undefined, undefined);
        return { ...serializeSummary(raced), replayed: true };
      }
      throw encounterError('Encounter could not be saved safely', 409);
    }
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      throw encounterError('Encounter data is invalid', 400);
    }
    throw encounterError('Unable to create encounter', 500);
  }

  await ensureAudit(actor.id, 'encounter_created', saved._id);
  return serializeSummary(saved);
}

async function assignEncounterDoctor(input, user) {
  const actor = await requireActiveUser(user, ['admin']);
  requireObject(input, 'Doctor assignment input');
  rejectUnknownFields(input, new Set(['encounterId', 'doctorId', 'idempotencyKey']), 'Doctor assignment input');
  if (!validObjectId(input.encounterId)) throw encounterError('A valid encounter ID is required');
  if (!validObjectId(input.doctorId)) throw encounterError('A valid doctor ID is required');
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);

  let doctor;
  try {
    doctor = await User.findById(String(input.doctorId)).select('_id role isActive').lean();
  } catch (_) {
    throw encounterError('Unable to verify assigned doctor', 500);
  }
  if (!doctor || doctor.isActive !== true || doctor.role !== 'doctor') {
    throw encounterError('An active doctor account is required for assignment', 400);
  }

  let current;
  try {
    current = await Encounter.findById(String(input.encounterId)).select('_id patient assignedDoctor status').lean();
  } catch (_) {
    throw encounterError('Unable to retrieve encounter for assignment', 500);
  }
  if (!current) throw encounterError('Encounter not found', 404);
  if (current.status === 'closed') throw encounterError('A closed encounter cannot be assigned', 409);

  const doctorId = doctor._id.toString();
  const operationKey = assignmentOperationKey(actor.id, current._id, idempotencyKey);
  const priorOperation = await auditExists(actor.id, 'encounter_doctor_assigned', current._id, operationKey);
  if (priorOperation) {
    if (current.status === 'closed' || String(current.assignedDoctor || '') !== doctorId) {
      throw encounterError('This idempotencyKey was already used for a different or superseded assignment', 409);
    }
    return { ...serializeSummary(await loadSummaryDocument(current._id)), replayed: true };
  }
  if (String(current.assignedDoctor || '') === doctorId) {
    await ensureAudit(actor.id, 'encounter_doctor_assigned', current._id, { operationKey, changeType: 'assignment_confirmed' }, operationKey);
    return { ...serializeSummary(await loadSummaryDocument(current._id)), replayed: true };
  }

  const filter = { _id: current._id, status: { $in: ['open', 'in_progress'] } };
  if (current.assignedDoctor) {
    filter.assignedDoctor = current.assignedDoctor;
  } else {
    filter.$or = [{ assignedDoctor: null }, { assignedDoctor: { $exists: false } }];
  }

  let updated;
  try {
    updated = await Encounter.findOneAndUpdate(
      filter,
      { $set: { assignedDoctor: doctor._id } },
      { new: true, runValidators: true }
    ).select(SUMMARY_FIELDS).lean();
  } catch (error) {
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      throw encounterError('Doctor assignment data is invalid', 400);
    }
    throw encounterError('Unable to assign doctor to encounter', 500);
  }
  if (!updated) throw encounterError('Encounter was changed or closed before assignment completed', 409);

  await ensureAudit(actor.id, 'encounter_doctor_assigned', updated._id, {
    operationKey,
    changeType: current.assignedDoctor ? 'reassigned' : 'assigned'
  }, operationKey);
  return serializeSummary(updated);
}

async function loadSummaryDocument(encounterId) {
  try {
    const encounter = await Encounter.findById(String(encounterId)).select(SUMMARY_FIELDS).lean();
    if (!encounter) throw encounterError('Encounter not found', 404);
    return encounter;
  } catch (error) {
    if (error.name === 'EncounterServiceError') throw error;
    throw encounterError('Unable to retrieve encounter details', 500);
  }
}

async function getEncounterDetails(encounterId, user) {
  const actor = await requireActiveUser(user, ['doctor', 'patient']);
  if (!validObjectId(encounterId)) throw encounterError('A valid encounter ID is required');
  const encounter = await loadSummaryDocument(encounterId);
  if (actor.role === 'doctor' && String(encounter.assignedDoctor || '') !== actor.id) {
    await recordEncounterVisibilityDenial(actor, encounter);
    throw encounterError('Doctors may view only encounters assigned to them', 403);
  }
  if (actor.role === 'patient' && String(encounter.patient) !== actor.patient) {
    await recordEncounterVisibilityDenial(actor, encounter);
    throw encounterError('Encounter not found', 404);
  }
  await authorizeEncounterRead(actor, encounter);
  return serializeSummary(encounter);
}

async function listEncounters(options, user) {
  const actor = await requireActiveUser(user, ['doctor', 'patient']);
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) {
    throw encounterError('Encounter list options must be an object');
  }
  const query = options || {};
  rejectUnknownFields(query, new Set(['page', 'limit']), 'Encounter list options');
  const page = parsePositiveInteger(query.page, 'Page', 1, MAX_PAGE);
  const limit = parsePositiveInteger(query.limit, 'Limit', DEFAULT_LIMIT, MAX_LIMIT);
  const filter = actor.role === 'patient'
    ? { patient: actor.patient }
    : { assignedDoctor: actor.id };
  const skip = (page - 1) * limit;

  let encounters;
  let total;
  try {
    [encounters, total] = await Promise.all([
      Encounter.find(filter).select(SUMMARY_FIELDS).sort({ openedAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      Encounter.countDocuments(filter)
    ]);
  } catch (_) {
    throw encounterError('Unable to retrieve encounter list', 500);
  }

  for (const encounter of encounters) {
    await authorizeEncounterRead(actor, encounter);
  }

  return {
    encounters: encounters.map(serializeSummary),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  };
}

async function closeEncounter(input, user) {
  const doctor = await requireActiveUser(user, ['doctor']);
  requireObject(input, 'Encounter closure input');
  rejectUnknownFields(input, new Set(['encounterId']), 'Encounter closure input');
  if (!validObjectId(input.encounterId)) throw encounterError('A valid encounter ID is required');

  let current;
  try {
    current = await Encounter.findById(String(input.encounterId)).select('_id patient assignedDoctor status closedAt').lean();
  } catch (_) {
    throw encounterError('Unable to retrieve encounter for closure', 500);
  }
  if (!current) throw encounterError('Encounter not found', 404);
  if (String(current.assignedDoctor || '') !== doctor.id) {
    throw encounterError('Only the assigned doctor may close this encounter', 403);
  }

  if (current.status === 'closed') {
    await ensureAudit(doctor.id, 'encounter_closed', current._id, { transition: 'closed' });
    return { ...serializeSummary(await loadSummaryDocument(current._id)), replayed: true };
  }

  const closedAt = new Date();
  let updated;
  try {
    updated = await Encounter.findOneAndUpdate(
      { _id: current._id, assignedDoctor: doctor.id, status: { $in: ['open', 'in_progress'] } },
      { $set: { status: 'closed', closedAt } },
      { new: true, runValidators: true }
    ).select(SUMMARY_FIELDS).lean();
  } catch (error) {
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      throw encounterError('Encounter closure data is invalid', 400);
    }
    throw encounterError('Unable to close encounter', 500);
  }
  if (!updated) throw encounterError('Encounter was changed or closed before closure completed', 409);

  await ensureAudit(doctor.id, 'encounter_closed', updated._id, { transition: 'closed' });
  return serializeSummary(updated);
}

module.exports = {
  createEncounter,
  assignEncounterDoctor,
  getEncounterDetails,
  listEncounters,
  closeEncounter
};
