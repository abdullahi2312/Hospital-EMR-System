const crypto = require('node:crypto');
const fs = require('node:fs');
const mongoose = require('mongoose');
const path = require('node:path');
const Diagnosis = require('../models/Diagnosis');
const Encounter = require('../models/Encounter');
const Patient = require('../models/Patient');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { authorizePatientRecordAccess } = require('./patient-access.service');
const { writeAuditLog } = require('./audit-log.service');

const DIAGNOSIS_AUDIT_ACTION = 'diagnosis_added';
const NOTE_AUDIT_ACTION = 'encounter_notes_updated';
const DIAGNOSIS_ENTITY_TYPE = 'Diagnosis';
const ENCOUNTER_ENTITY_TYPE = 'Encounter';
const ICD10_CATALOG_PATH = path.join(__dirname, '..', 'data', 'icd10-cm-fy2027.json');
const ICD10_CATALOG_UNAVAILABLE_MESSAGE = 'ICD-10-CM FY 2027 catalog is unavailable or invalid';
let icd10CatalogCache;

function serviceError(message, status = 400, properties = {}) {
  const error = new Error(message);
  error.name = 'DiagnosisServiceError';
  error.status = status;
  error.statusCode = status;
  Object.assign(error, properties);
  return error;
}

function validObjectId(value) {
  return mongoose.isObjectIdOrHexString(value);
}

function normalizeText(value, field, maxLength, required = false) {
  if (value === undefined || value === null) {
    if (required) throw serviceError(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw serviceError(`${field} must be text`);
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if ((required && !normalized) || normalized.length > maxLength) {
    throw serviceError(`${field} is invalid`);
  }
  return normalized || undefined;
}

function loadIcd10Catalog() {
  if (icd10CatalogCache) return icd10CatalogCache;

  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(ICD10_CATALOG_PATH, 'utf8'));
  } catch (_) {
    throw serviceError(ICD10_CATALOG_UNAVAILABLE_MESSAGE, 503, { icd10CatalogUnavailable: true });
  }

  const metadata = catalog?.metadata;
  const validityDefinition = metadata?.fieldDefinitions?.validityFlag;
  if (
    metadata?.terminology !== 'ICD-10-CM' ||
    metadata?.fiscalYear !== 2027 ||
    metadata?.effectiveFrom !== '2026-10-01' ||
    metadata?.effectiveTo !== '2027-09-30' ||
    typeof metadata?.officialSource !== 'string' ||
    !metadata.officialSource.includes('CDC/NCHS') ||
    !metadata.officialSource.includes('FY 2027') ||
    metadata?.sourceUrl !== 'https://ftp.cdc.gov/pub/health_statistics/nchs/Publications/ICD10CM/2027/' ||
    metadata?.cmsReferenceUrl !== 'https://www.cms.gov/medicare/coding-billing/icd-10-codes' ||
    typeof metadata?.sourceArchiveSha256 !== 'string' ||
    !/^[a-f\d]{64}$/i.test(metadata.sourceArchiveSha256) ||
    !Number.isInteger(metadata?.reportableRecordCount) ||
    !Number.isInteger(metadata?.sourceOrderEntries) ||
    !Number.isInteger(metadata?.excludedHeaders) ||
    typeof validityDefinition !== 'string' ||
    !validityDefinition.includes('1 = reportable/valid for HIPAA-covered transactions') ||
    !validityDefinition.includes('0 = non-reportable header') ||
    typeof metadata?.attribution !== 'string' ||
    !metadata.attribution.includes('CDC/NCHS') ||
    typeof metadata?.disclaimer !== 'string' ||
    !metadata.disclaimer.includes('does not imply endorsement') ||
    !Array.isArray(catalog.codes) ||
    catalog.codes.length !== metadata.reportableRecordCount ||
    catalog.codes.length + metadata.excludedHeaders !== metadata.sourceOrderEntries
  ) {
    throw serviceError(ICD10_CATALOG_UNAVAILABLE_MESSAGE, 503, { icd10CatalogUnavailable: true });
  }

  const byCode = new Map();
  const seenOrders = new Set();
  for (const record of catalog.codes) {
    if (
      !record ||
      typeof record.code !== 'string' ||
      !/^[A-Z][A-Z0-9]{2,6}$/.test(record.code) ||
      typeof record.longDescription !== 'string' ||
      record.longDescription.trim().length === 0 ||
      typeof record.shortDescription !== 'string' ||
      record.shortDescription.trim().length === 0 ||
      !Number.isInteger(record.tabularOrder) ||
      record.tabularOrder < 1 ||
      record.tabularOrder > metadata.sourceOrderEntries ||
      seenOrders.has(record.tabularOrder) ||
      record.validityFlag !== 1 ||
      byCode.has(record.code)
    ) {
      throw serviceError(ICD10_CATALOG_UNAVAILABLE_MESSAGE, 503, { icd10CatalogUnavailable: true });
    }
    seenOrders.add(record.tabularOrder);
    byCode.set(record.code, {
      code: record.code,
      longDescription: record.longDescription,
      shortDescription: record.shortDescription,
      tabularOrder: record.tabularOrder,
      validityFlag: record.validityFlag
    });
  }

  if (byCode.size !== metadata.reportableRecordCount) {
    throw serviceError(ICD10_CATALOG_UNAVAILABLE_MESSAGE, 503, { icd10CatalogUnavailable: true });
  }

  icd10CatalogCache = byCode;
  return icd10CatalogCache;
}

function normalizeIcd10Code(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw serviceError('ICD-10 code must be text');
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const upperCode = trimmed.toUpperCase();
  let undottedCode;
  if (/^[A-Z][A-Z0-9]{2,6}$/.test(upperCode)) {
    undottedCode = upperCode;
  } else if (/^[A-Z0-9]{3}\.[A-Z0-9]{1,4}$/.test(upperCode) && /^[A-Z]/.test(upperCode)) {
    undottedCode = upperCode.replace('.', '');
  } else {
    throw serviceError('ICD-10 code format is invalid');
  }
  return undottedCode;
}

async function requireActiveDoctor(user) {
  if (!user || typeof user !== 'object' || !validObjectId(user.id)) {
    throw serviceError('Authentication required', 401);
  }
  let currentUser;
  try {
    currentUser = await User.findById(String(user.id)).select('_id role isActive').lean();
  } catch (_) {
    throw serviceError('Unable to verify authenticated user', 500);
  }
  if (!currentUser || currentUser.isActive !== true) {
    throw serviceError('Authentication required', 401);
  }
  if (currentUser.role !== 'doctor') {
    throw serviceError('Only active doctors may manage encounter diagnoses or notes', 403);
  }
  return { id: currentUser._id.toString(), role: currentUser.role };
}

async function loadAuthorizedEncounter(encounterId, patientId, user, reason, options = {}) {
  if (!validObjectId(encounterId)) throw serviceError('A valid encounter ID is required');
  if (patientId !== undefined && !validObjectId(patientId)) {
    throw serviceError('A valid patient ID is required');
  }

  let encounter;
  try {
    let query = Encounter.findById(String(encounterId))
      .select(options.fields || '_id patient assignedDoctor');
    if (!options.asDocument) query = query.lean();
    encounter = await query;
  } catch (_) {
    throw serviceError('Unable to verify encounter', 500);
  }
  if (!encounter) throw serviceError('Encounter not found', 404);
  if (patientId !== undefined && String(encounter.patient) !== String(patientId)) {
    throw serviceError('Encounter does not belong to the specified patient', 400);
  }

  let patientExists;
  try {
    patientExists = await Patient.exists({ _id: encounter.patient });
  } catch (_) {
    throw serviceError('Unable to verify encounter patient', 500);
  }
  if (!patientExists) throw serviceError('Encounter patient not found', 404);

  let access;
  try {
    access = await authorizePatientRecordAccess(
      user,
      String(encounter.patient),
      String(encounter._id),
      reason
    );
  } catch (_) {
    throw serviceError('Unable to verify patient-record access', 500);
  }
  if (!access.allowed) {
    throw serviceError(access.message || 'Access to this patient record is not permitted', access.statusCode || 403);
  }
  return encounter;
}

function requestIdempotentId(key, doctorId, encounterId, code) {
  if (typeof key !== 'string' || key.trim().length < 8 || key.trim().length > 128) {
    throw serviceError('An idempotencyKey between 8 and 128 characters is required');
  }
  const identity = code
    ? `diagnosis-code:${encounterId}:${code.toUpperCase()}`
    : `diagnosis-request:${doctorId}:${encounterId}:${key.trim()}`;
  return new mongoose.Types.ObjectId(
    crypto.createHash('sha256').update(identity).digest().subarray(0, 12)
  );
}

function serializeDiagnosis(diagnosis) {
  return {
    id: diagnosis._id.toString(),
    patient: diagnosis.patient.toString(),
    encounter: diagnosis.encounter.toString(),
    doctor: diagnosis.doctor.toString(),
    ...(diagnosis.code ? { code: diagnosis.code } : {}),
    description: diagnosis.description,
    isPrimary: diagnosis.isPrimary,
    diagnosedAt: diagnosis.diagnosedAt
  };
}

function sameDiagnosisRequest(diagnosis, values, doctorId) {
  return String(diagnosis.patient) === String(values.patient) &&
    String(diagnosis.encounter) === String(values.encounter) &&
    String(diagnosis.doctor) === doctorId &&
    (diagnosis.code || undefined) === values.code &&
    diagnosis.description === values.description &&
    diagnosis.isPrimary === values.isPrimary;
}

async function ensureDiagnosisAudit(diagnosis, doctorId) {
  let event;
  try {
    event = await AuditLog.findOne({
      actor: doctorId,
      action: DIAGNOSIS_AUDIT_ACTION,
      entityType: DIAGNOSIS_ENTITY_TYPE,
      entityId: diagnosis._id
    }).select('_id').lean();
  } catch (_) {
    throw serviceError('Unable to verify diagnosis audit state', 503, {
      partialSuccess: true,
      diagnosisId: diagnosis._id.toString()
    });
  }
  if (event) return;

  try {
    await writeAuditLog({
      actorId: doctorId,
      action: DIAGNOSIS_AUDIT_ACTION,
      entityType: DIAGNOSIS_ENTITY_TYPE,
      entityId: diagnosis._id
    });
  } catch (_) {
    throw serviceError(
      'Diagnosis was saved, but audit logging failed. Retry with the same idempotencyKey to avoid a duplicate.',
      503,
      { partialSuccess: true, diagnosisId: diagnosis._id.toString() }
    );
  }
}

async function addDiagnosis(input, user) {
  const doctor = await requireActiveDoctor(user);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw serviceError('Diagnosis input must be an object');
  }
  const allowedFields = new Set([
    'patient', 'encounter', 'code', 'description', 'isPrimary', 'idempotencyKey'
  ]);
  if (Object.keys(input).some((field) => !allowedFields.has(field))) {
    throw serviceError('Diagnosis input contains unsupported or server-managed fields');
  }
  if (!validObjectId(input.patient)) throw serviceError('A valid patient ID is required');
  if (!validObjectId(input.encounter)) throw serviceError('A valid encounter ID is required');
  const requestedCode = normalizeIcd10Code(input.code);
  let description = requestedCode
    ? undefined
    : normalizeText(input.description, 'Diagnosis description', 1000, true);
  if (input.isPrimary !== undefined && typeof input.isPrimary !== 'boolean') {
    throw serviceError('isPrimary must be a boolean');
  }
  const isPrimary = input.isPrimary ?? false;
  const patient = new mongoose.Types.ObjectId(String(input.patient));
  const encounterId = new mongoose.Types.ObjectId(String(input.encounter));
  const encounter = await loadAuthorizedEncounter(
    encounterId,
    patient,
    doctor,
    'Add encounter diagnosis'
  );
  let code;
  if (requestedCode) {
    const catalog = loadIcd10Catalog();
    const catalogEntry = catalog.get(requestedCode);
    if (!catalogEntry) {
      throw serviceError('ICD-10 code is unknown or not reportable in the FY 2027 catalog', 400);
    }
    code = catalogEntry.code;
    description = catalogEntry.longDescription;
  }
  const diagnosisId = requestIdempotentId(input.idempotencyKey, doctor.id, encounter._id, code);
  const values = {
    patient: new mongoose.Types.ObjectId(String(encounter.patient)),
    encounter: new mongoose.Types.ObjectId(String(encounter._id)),
    code,
    description,
    isPrimary
  };

  let existing;
  try {
    existing = await Diagnosis.findById(diagnosisId).lean();
  } catch (_) {
    throw serviceError('Unable to check for a previous diagnosis submission', 500);
  }
  if (existing) {
    if (!sameDiagnosisRequest(existing, values, doctor.id)) {
      throw serviceError('This idempotencyKey was already used for a different diagnosis', 409);
    }
    await ensureDiagnosisAudit(existing, doctor.id);
    return { ...serializeDiagnosis(existing), replayed: true };
  }

  if (code) {
    let duplicate;
    try {
      duplicate = await Diagnosis.findOne({ encounter: encounter._id, code }).select('_id').lean();
    } catch (_) {
      throw serviceError('Unable to check for duplicate diagnosis', 500);
    }
    if (duplicate) throw serviceError('This ICD-10 code is already recorded for the encounter', 409);
  }

  const diagnosis = new Diagnosis({
    _id: diagnosisId,
    ...values,
    doctor: doctor.id,
    diagnosedAt: new Date()
  });
  try {
    await diagnosis.save();
  } catch (error) {
    if (error.code === 11000) {
      let duplicate;
      try {
        duplicate = await Diagnosis.findById(diagnosisId).lean();
      } catch (_) {
        throw serviceError('Unable to verify diagnosis submission', 500);
      }
      if (duplicate && sameDiagnosisRequest(duplicate, values, doctor.id)) {
        await ensureDiagnosisAudit(duplicate, doctor.id);
        return { ...serializeDiagnosis(duplicate), replayed: true };
      }
      if (code) throw serviceError('This ICD-10 code is already recorded for the encounter', 409);
      throw serviceError('Diagnosis submission could not be saved safely', 409);
    }
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      throw serviceError('Diagnosis data is invalid', 400);
    }
    throw serviceError('Unable to save diagnosis', 500);
  }

  await ensureDiagnosisAudit(diagnosis, doctor.id);
  return serializeDiagnosis(diagnosis);
}

async function getEncounterDiagnoses(encounterId, user) {
  const doctor = await requireActiveDoctor(user);
  const encounter = await loadAuthorizedEncounter(
    encounterId,
    undefined,
    doctor,
    'Retrieve encounter diagnoses'
  );

  let diagnoses;
  try {
    diagnoses = await Diagnosis.find({
      encounter: encounter._id,
      patient: encounter.patient
    })
      .sort({ diagnosedAt: -1, _id: -1 })
      .lean();
  } catch (_) {
    throw serviceError('Unable to retrieve encounter diagnoses', 500);
  }
  return diagnoses.map(serializeDiagnosis);
}

async function updateEncounterNotes(input, user) {
  const doctor = await requireActiveDoctor(user);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw serviceError('Encounter notes input must be an object');
  }
  const noteFieldLimits = {
    clinicalNotes: 10000,
    examinationFindings: 10000,
    assessment: 5000,
    treatmentPlan: 10000,
    followUpInstructions: 5000
  };
  const allowedFields = new Set(['patient', 'encounter', ...Object.keys(noteFieldLimits)]);
  if (Object.keys(input).some((field) => !allowedFields.has(field))) {
    throw serviceError('Encounter notes input contains unsupported or server-managed fields');
  }
  if (!validObjectId(input.encounter)) throw serviceError('A valid encounter ID is required');
  if (input.patient !== undefined && !validObjectId(input.patient)) {
    throw serviceError('A valid patient ID is required');
  }
  const fieldsToUpdate = Object.keys(noteFieldLimits)
    .filter((field) => Object.prototype.hasOwnProperty.call(input, field));
  if (fieldsToUpdate.length === 0) {
    throw serviceError('Provide at least one clinical note, examination, assessment, treatment, or follow-up field');
  }

  const normalizedValues = {};
  for (const field of fieldsToUpdate) {
    const value = input[field];
    if (typeof value !== 'string') throw serviceError(`${field} must be text`);
    const normalized = value.normalize('NFKC').trim();
    if (normalized.length > noteFieldLimits[field]) {
      throw serviceError(`${field} cannot exceed ${noteFieldLimits[field]} characters`);
    }
    // An explicitly empty string clears that field; omitted fields are preserved.
    normalizedValues[field] = normalized || undefined;
  }

  const encounter = await loadAuthorizedEncounter(
    input.encounter,
    input.patient,
    doctor,
    'Update encounter notes',
    {
      asDocument: true,
      fields: `_id patient assignedDoctor ${Object.keys(noteFieldLimits).join(' ')}`
    }
  );

  for (const field of fieldsToUpdate) {
    encounter.set(field, normalizedValues[field]);
  }

  try {
    await encounter.save();
  } catch (error) {
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      throw serviceError('Encounter clinical notes are invalid', 400);
    }
    throw serviceError('Unable to save encounter clinical notes', 500);
  }

  try {
    await writeAuditLog({
      actorId: doctor.id,
      action: NOTE_AUDIT_ACTION,
      entityType: ENCOUNTER_ENTITY_TYPE,
      entityId: encounter._id
    });
  } catch (_) {
    throw serviceError(
      'Encounter notes were saved, but audit logging failed. Verify the encounter before retrying.',
      503,
      { partialSuccess: true, encounterId: encounter._id.toString() }
    );
  }

  return {
    id: encounter._id.toString(),
    patient: encounter.patient.toString(),
    updatedFields: fieldsToUpdate,
    clinicalNotes: encounter.clinicalNotes,
    examinationFindings: encounter.examinationFindings,
    assessment: encounter.assessment,
    treatmentPlan: encounter.treatmentPlan,
    followUpInstructions: encounter.followUpInstructions,
    updatedAt: encounter.updatedAt
  };
}

module.exports = {
  addDiagnosis,
  getEncounterDiagnoses,
  updateEncounterNotes
};
