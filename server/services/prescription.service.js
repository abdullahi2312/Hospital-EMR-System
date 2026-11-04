const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Allergy = require('../models/Allergy');
const AuditLog = require('../models/AuditLog');
const Encounter = require('../models/Encounter');
const Medication = require('../models/Medication');
const Patient = require('../models/Patient');
const Prescription = require('../models/Prescription');
const User = require('../models/User');
const { authorizePatientRecordAccess } = require('./patient-access.service');
const { writeAuditLog } = require('./audit-log.service');

const AUDIT_ACTION = 'prescription_created';
const ENTITY_TYPE = 'Prescription';
const PRESCRIPTION_ROUTES = ['oral', 'injection', 'topical', 'inhalation', 'other'];
const INPUT_FIELDS = new Set([
  'encounter',
  'medicationId',
  'dose',
  'route',
  'frequency',
  'duration',
  'quantity',
  'instructions',
  'idempotencyKey'
]);

function serviceError(message, status = 400, properties = {}) {
  const error = new Error(message);
  error.name = 'PrescriptionServiceError';
  error.status = status;
  error.statusCode = status;
  Object.assign(error, properties);
  return error;
}

function validObjectId(value) {
  return mongoose.isObjectIdOrHexString(value);
}

function normalizeText(value, field, maxLength, required = true) {
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

function positiveNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw serviceError(`${field} must be a positive number`);
  }
  return value;
}

function normalizeIdempotencyKey(value) {
  if (typeof value !== 'string') {
    throw serviceError('An idempotencyKey between 8 and 128 characters is required');
  }
  const key = value.trim();
  if (key.length < 8 || key.length > 128) {
    throw serviceError('An idempotencyKey between 8 and 128 characters is required');
  }
  return key;
}

function requestId(key, doctorId) {
  const digest = crypto.createHash('sha256')
    .update(`prescription:${doctorId}:${key}`)
    .digest()
    .subarray(0, 12);
  return new mongoose.Types.ObjectId(digest);
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
    throw serviceError('Only active doctors may prescribe medication', 403);
  }
  return { id: currentUser._id.toString(), role: currentUser.role };
}

async function loadAuthorizedEncounter(encounterId, doctor) {
  if (!validObjectId(encounterId)) throw serviceError('A valid encounter ID is required');

  let encounter;
  try {
    encounter = await Encounter.findById(String(encounterId))
      .select('_id patient assignedDoctor status')
      .lean();
  } catch (_) {
    throw serviceError('Unable to verify encounter', 500);
  }
  if (!encounter) throw serviceError('Encounter not found', 404);
  if (!validObjectId(encounter.patient)) throw serviceError('Encounter patient is invalid', 500);

  let patient;
  try {
    patient = await Patient.findById(String(encounter.patient))
      .select('_id allergies allergyStatus')
      .lean();
  } catch (_) {
    throw serviceError('Unable to verify encounter patient', 500);
  }
  if (!patient) throw serviceError('Encounter patient not found', 404);

  let access;
  try {
    access = await authorizePatientRecordAccess(
      doctor,
      String(patient._id),
      String(encounter._id),
      'Create medication prescription'
    );
  } catch (_) {
    throw serviceError('Unable to verify patient-record access', 500);
  }
  if (!access.allowed) {
    throw serviceError(
      access.message || 'Access to this patient record is not permitted',
      access.statusCode || 403
    );
  }
  return { encounter, patient };
}

function normalizeAllergyText(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function phraseMatches(left, right) {
  const a = normalizeAllergyText(left);
  const b = normalizeAllergyText(right);
  if (!a || !b) return false;
  if (a === b) return true;
  // Match only complete token sequences (e.g. a catalog alias plus a suffix),
  // never arbitrary substrings inside unrelated words.
  return ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `);
}

async function findPossibleAllergyMatch(patient, medication) {
  let recordedAllergies;
  try {
    recordedAllergies = await Allergy.find({ patient: patient._id, status: 'active' })
      .select('allergen allergenGroup')
      .lean();
  } catch (_) {
    throw serviceError('Unable to check recorded allergies', 500);
  }

  const medicationNames = [medication.name, medication.genericName, medication.brandName]
    .filter((value) => typeof value === 'string' && value.trim());
  const patientAllergies = Array.isArray(patient.allergies) ? patient.allergies : [];
  const allergyTerms = [
    ...patientAllergies.map((allergen) => ({ allergen })),
    ...recordedAllergies
  ];

  for (const allergy of allergyTerms) {
    if (medicationNames.some((name) => phraseMatches(name, allergy.allergen))) return true;
    if (allergy.allergenGroup && phraseMatches(medication.category, allergy.allergenGroup)) return true;
  }
  return false;
}

function sameRequest(prescription, data, doctorId) {
  return String(prescription.encounter) === data.encounterId &&
    String(prescription.patient) === data.patientId &&
    String(prescription.doctor) === doctorId &&
    prescription.drugName === data.drugName &&
    prescription.dose === data.dose &&
    prescription.route === data.route &&
    prescription.frequency === data.frequency &&
    prescription.duration === data.duration &&
    prescription.quantity === data.quantity &&
    (prescription.instructions || undefined) === data.instructions;
}

function serializePrescription(prescription) {
  return {
    id: prescription._id.toString(),
    patient: prescription.patient.toString(),
    encounter: prescription.encounter.toString(),
    doctor: prescription.doctor.toString(),
    drugName: prescription.drugName,
    dose: prescription.dose,
    route: prescription.route,
    frequency: prescription.frequency,
    duration: prescription.duration,
    quantity: prescription.quantity,
    ...(prescription.instructions ? { instructions: prescription.instructions } : {}),
    status: prescription.status,
    prescribedAt: prescription.prescribedAt
  };
}

async function ensureAudit(prescription, doctorId) {
  let existingAudit;
  try {
    existingAudit = await AuditLog.findOne({
      actor: doctorId,
      action: AUDIT_ACTION,
      entityType: ENTITY_TYPE,
      entityId: prescription._id
    }).select('_id').lean();
  } catch (_) {
    throw serviceError('Unable to verify prescription audit state', 503, {
      partialSuccess: true,
      prescriptionId: prescription._id.toString()
    });
  }
  if (existingAudit) return;

  try {
    // Clinical or allergy details are intentionally omitted from audit metadata.
    await writeAuditLog({
      actorId: doctorId,
      action: AUDIT_ACTION,
      entityType: ENTITY_TYPE,
      entityId: prescription._id
    });
  } catch (_) {
    throw serviceError(
      'Prescription was saved, but audit logging failed. Retry with the same idempotencyKey to avoid creating a duplicate.',
      503,
      { partialSuccess: true, prescriptionId: prescription._id.toString() }
    );
  }
}

async function createPrescription(input, user) {
  const doctor = await requireActiveDoctor(user);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw serviceError('Prescription input must be an object');
  }
  if (Object.keys(input).some((field) => !INPUT_FIELDS.has(field))) {
    throw serviceError('Prescription input contains unsupported or server-managed fields');
  }
  if (!validObjectId(input.encounter)) throw serviceError('A valid encounter ID is required');
  if (!validObjectId(input.medicationId)) throw serviceError('A valid medication ID is required');

  const data = {
    encounterId: String(input.encounter),
    medicationId: String(input.medicationId),
    dose: normalizeText(input.dose, 'Dose', 100),
    route: normalizeText(input.route, 'Route', 40),
    frequency: normalizeText(input.frequency, 'Frequency', 200),
    duration: positiveNumber(input.duration, 'Duration'),
    quantity: positiveNumber(input.quantity, 'Quantity'),
    instructions: normalizeText(input.instructions, 'Instructions', 2000, false),
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey)
  };
  if (!PRESCRIPTION_ROUTES.includes(data.route)) {
    throw serviceError('Route must be oral, injection, topical, inhalation, or other');
  }

  const { encounter, patient } = await loadAuthorizedEncounter(data.encounterId, doctor);
  let medication;
  try {
    medication = await Medication.findById(data.medicationId)
      .select('_id name genericName brandName category isActive')
      .lean();
  } catch (_) {
    throw serviceError('Unable to verify medication', 500);
  }
  if (!medication) throw serviceError('Medication not found', 404);
  if (medication.isActive !== true) throw serviceError('Medication is inactive and cannot be prescribed', 409);
  if (data.route !== medication.route) {
    throw serviceError('Prescription route does not match the medication catalog', 400);
  }

  let hasPossibleAllergyMatch;
  try {
    hasPossibleAllergyMatch = await findPossibleAllergyMatch(patient, medication);
  } catch (error) {
    if (error.name === 'PrescriptionServiceError') throw error;
    throw serviceError('Unable to check recorded allergies', 500);
  }
  if (hasPossibleAllergyMatch) {
    throw serviceError(
      'Possible allergy match found. Prescription blocked; review the recorded allergy before prescribing.',
      409,
      { allergyWarning: true }
    );
  }

  data.patientId = String(patient._id);
  data.drugName = medication.name;
  const prescriptionId = requestId(data.idempotencyKey, doctor.id);

  let existing;
  try {
    existing = await Prescription.findById(prescriptionId).lean();
  } catch (_) {
    throw serviceError('Unable to check for a previous prescription submission', 500);
  }
  if (existing) {
    if (!sameRequest(existing, data, doctor.id)) {
      throw serviceError('This idempotencyKey was already used for a different prescription', 409);
    }
    await ensureAudit(existing, doctor.id);
    return { ...serializePrescription(existing), replayed: true };
  }

  const prescription = new Prescription({
    _id: prescriptionId,
    patient: patient._id,
    encounter: encounter._id,
    doctor: doctor.id,
    drugName: medication.name,
    dose: data.dose,
    route: data.route,
    frequency: data.frequency,
    duration: data.duration,
    quantity: data.quantity,
    ...(data.instructions ? { instructions: data.instructions } : {}),
    prescribedAt: new Date()
  });
  try {
    await prescription.save();
  } catch (error) {
    if (error.code === 11000) {
      let concurrent;
      try {
        concurrent = await Prescription.findById(prescriptionId).lean();
      } catch (_) {
        throw serviceError('Unable to verify prescription submission', 500);
      }
      if (concurrent && sameRequest(concurrent, data, doctor.id)) {
        await ensureAudit(concurrent, doctor.id);
        return { ...serializePrescription(concurrent), replayed: true };
      }
      throw serviceError('Prescription submission could not be saved safely', 409);
    }
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      throw serviceError('Prescription data is invalid', 400);
    }
    throw serviceError('Unable to save prescription', 500);
  }

  await ensureAudit(prescription, doctor.id);
  return serializePrescription(prescription);
}

module.exports = {
  createPrescription
};
