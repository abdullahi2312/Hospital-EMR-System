const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Vital = require('../models/Vital');
const Encounter = require('../models/Encounter');
const Patient = require('../models/Patient');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { authorizePatientRecordAccess } = require('./patient-access.service');
const { writeAuditLog } = require('./audit-log.service');

const VITAL_AUDIT_ACTION = 'vitals_recorded';
const VITAL_ENTITY_TYPE = 'Vital';
const HOURS_IN_MS = 60 * 60 * 1000;

function serviceError(message, status = 400, properties = {}) {
  const error = new Error(message);
  error.name = 'VitalServiceError';
  error.status = status;
  error.statusCode = status;
  Object.assign(error, properties);
  return error;
}

function validObjectId(value) {
  return mongoose.isObjectIdOrHexString(value);
}

function finiteNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw serviceError(`${field} must be a finite number`);
  }
  return value;
}

function readLimit(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw serviceError('Vital limit configuration is invalid', 500);
  }
  return parsed;
}

function clinicalLimits() {
  const limits = {
    temperatureMin: readLimit('VITAL_MIN_TEMPERATURE_C', 20, 10, 25),
    temperatureMax: readLimit('VITAL_MAX_TEMPERATURE_C', 45, 40, 45),
    pulseMin: readLimit('VITAL_MIN_PULSE_BPM', 1, 1, 20),
    pulseMax: readLimit('VITAL_MAX_PULSE_BPM', 300, 120, 400),
    systolicMin: readLimit('VITAL_MIN_SYSTOLIC_MMHG', 40, 10, 80),
    systolicMax: readLimit('VITAL_MAX_SYSTOLIC_MMHG', 300, 180, 350),
    diastolicMin: readLimit('VITAL_MIN_DIASTOLIC_MMHG', 20, 5, 50),
    diastolicMax: readLimit('VITAL_MAX_DIASTOLIC_MMHG', 200, 120, 250),
    weightMin: readLimit('VITAL_MIN_WEIGHT_KG', 0.1, 0.01, 1),
    weightMax: readLimit('VITAL_MAX_WEIGHT_KG', 500, 250, 1000),
    heightMin: readLimit('VITAL_MIN_HEIGHT_CM', 20, 5, 30),
    heightMax: readLimit('VITAL_MAX_HEIGHT_CM', 300, 250, 350)
  };
  if (
    limits.temperatureMin >= limits.temperatureMax ||
    limits.pulseMin >= limits.pulseMax ||
    limits.systolicMin >= limits.systolicMax ||
    limits.diastolicMin >= limits.diastolicMax ||
    limits.weightMin >= limits.weightMax ||
    limits.heightMin >= limits.heightMax
  ) {
    throw serviceError('Vital limit configuration is invalid', 500);
  }
  return limits;
}

function validateVitalInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw serviceError('Vital input must be an object');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'respiratoryRate')) {
    throw serviceError('Respiratory rate is not supported by the current Vital model');
  }
  if (!validObjectId(input.patient)) {
    throw serviceError('A valid patient ID is required');
  }
  if (!validObjectId(input.encounter)) {
    throw serviceError('A valid encounter ID is required');
  }

  const limits = clinicalLimits();
  const sourceBloodPressure = input.bloodPressure;
  if (!sourceBloodPressure || typeof sourceBloodPressure !== 'object' || Array.isArray(sourceBloodPressure)) {
    throw serviceError('Blood pressure with systolic and diastolic values is required');
  }
  const systolic = finiteNumber(sourceBloodPressure.systolic, 'Systolic blood pressure');
  const diastolic = finiteNumber(sourceBloodPressure.diastolic, 'Diastolic blood pressure');
  const temperature = finiteNumber(input.temperature, 'Temperature');
  const pulseValue = input.pulse ?? input.heartRate;
  if (input.pulse !== undefined && input.heartRate !== undefined && input.pulse !== input.heartRate) {
    throw serviceError('Pulse and heartRate values must match when both are supplied');
  }
  const pulse = finiteNumber(pulseValue, 'Pulse');
  const weight = finiteNumber(input.weight, 'Weight');
  const height = input.height === undefined ? undefined : finiteNumber(input.height, 'Height');
  const oxygenSaturation = input.oxygenSaturation === undefined
    ? undefined
    : finiteNumber(input.oxygenSaturation, 'Oxygen saturation');

  if (systolic < limits.systolicMin || systolic > limits.systolicMax ||
      diastolic < limits.diastolicMin || diastolic > limits.diastolicMax || systolic <= diastolic) {
    throw serviceError('Blood pressure is outside the accepted physiological limits');
  }
  if (temperature < limits.temperatureMin || temperature > limits.temperatureMax) {
    throw serviceError('Temperature is outside the accepted physiological limits');
  }
  if (pulse < limits.pulseMin || pulse > limits.pulseMax) {
    throw serviceError('Pulse is outside the accepted physiological limits');
  }
  if (weight < limits.weightMin || weight > limits.weightMax) {
    throw serviceError('Weight is outside the accepted physiological limits');
  }
  if (height !== undefined && (height < limits.heightMin || height > limits.heightMax)) {
    throw serviceError('Height is outside the accepted physiological limits');
  }
  if (oxygenSaturation !== undefined && (oxygenSaturation < 0 || oxygenSaturation > 100)) {
    throw serviceError('Oxygen saturation must be between 0 and 100');
  }

  return {
    patient: new mongoose.Types.ObjectId(String(input.patient)),
    encounter: new mongoose.Types.ObjectId(String(input.encounter)),
    bloodPressure: { systolic, diastolic },
    temperature,
    pulse,
    weight,
    ...(height !== undefined ? { height } : {}),
    ...(oxygenSaturation !== undefined ? { oxygenSaturation } : {}),
    limits
  };
}

function getAbnormalFlags(vital) {
  const flags = [];
  const bp = vital.bloodPressure;
  if (bp.systolic < 90) flags.push({ measurement: 'systolic', status: 'low' });
  if (bp.systolic > 180) flags.push({ measurement: 'systolic', status: 'high' });
  if (bp.diastolic < 60) flags.push({ measurement: 'diastolic', status: 'low' });
  if (bp.diastolic > 120) flags.push({ measurement: 'diastolic', status: 'high' });
  if (vital.temperature < 36) flags.push({ measurement: 'temperature', status: 'low' });
  if (vital.temperature > 38) flags.push({ measurement: 'temperature', status: 'high' });
  if (vital.pulse < 50) flags.push({ measurement: 'pulse', status: 'low' });
  if (vital.pulse > 120) flags.push({ measurement: 'pulse', status: 'high' });
  if (vital.oxygenSaturation !== undefined && vital.oxygenSaturation < 92) {
    flags.push({ measurement: 'oxygenSaturation', status: 'low' });
  }
  return flags;
}

function serializeVital(vital) {
  const result = {
    id: vital._id.toString(),
    patient: vital.patient.toString(),
    encounter: vital.encounter.toString(),
    recordedBy: vital.recordedBy.toString(),
    bloodPressure: {
      systolic: vital.bloodPressure.systolic,
      diastolic: vital.bloodPressure.diastolic
    },
    temperature: vital.temperature,
    pulse: vital.pulse,
    weight: vital.weight,
    ...(vital.height !== undefined ? { height: vital.height } : {}),
    ...(vital.oxygenSaturation !== undefined ? { oxygenSaturation: vital.oxygenSaturation } : {}),
    recordedAt: vital.recordedAt,
    abnormalFlags: getAbnormalFlags(vital)
  };
  return result;
}

function hashRequestKey(key, userId) {
  if (typeof key !== 'string' || key.trim().length < 8 || key.trim().length > 128) {
    throw serviceError('An idempotencyKey between 8 and 128 characters is required');
  }
  return new mongoose.Types.ObjectId(
    crypto.createHash('sha256').update(`${userId}:${key.trim()}`).digest().subarray(0, 12)
  );
}

function sameVitalRequest(vital, data, userId) {
  return String(vital.patient) === String(data.patient) &&
    String(vital.encounter) === String(data.encounter) &&
    String(vital.recordedBy) === userId &&
    vital.bloodPressure?.systolic === data.bloodPressure.systolic &&
    vital.bloodPressure?.diastolic === data.bloodPressure.diastolic &&
    vital.temperature === data.temperature &&
    vital.pulse === data.pulse &&
    vital.weight === data.weight &&
    vital.height === data.height &&
    vital.oxygenSaturation === data.oxygenSaturation;
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
    throw serviceError('Only doctors may record or retrieve encounter vitals', 403);
  }
  return {
    id: currentUser._id.toString(),
    role: currentUser.role
  };
}

async function loadEncounter(encounterId, patientId) {
  let encounter;
  try {
    encounter = await Encounter.findById(encounterId)
      .select('_id patient assignedDoctor')
      .lean();
  } catch (_) {
    throw serviceError('Unable to verify encounter', 500);
  }
  if (!encounter) throw serviceError('Encounter not found', 404);
  if (patientId && String(encounter.patient) !== String(patientId)) {
    throw serviceError('Encounter does not belong to the specified patient', 400);
  }

  let patientExists;
  try {
    patientExists = await Patient.exists({ _id: encounter.patient });
  } catch (_) {
    throw serviceError('Unable to verify encounter patient', 500);
  }
  if (!patientExists) throw serviceError('Encounter patient not found', 404);
  return encounter;
}

async function authorizeEncounterAccess(user, encounter, accessReason) {
  let access;
  try {
    access = await authorizePatientRecordAccess(
      user,
      String(encounter.patient),
      String(encounter._id),
      accessReason
    );
  } catch (_) {
    throw serviceError('Unable to verify patient-record access', 500);
  }
  if (!access.allowed) {
    throw serviceError(access.message || 'Access to this patient record is not permitted', access.statusCode || 403);
  }
}

async function findExistingVital(vitalId) {
  try {
    return await Vital.findById(vitalId).lean();
  } catch (_) {
    throw serviceError('Unable to verify previous vital submission', 500);
  }
}

async function auditVital(vital, actorId) {
  try {
    await writeAuditLog({
      actorId,
      action: VITAL_AUDIT_ACTION,
      entityType: VITAL_ENTITY_TYPE,
      entityId: vital._id
    });
  } catch (_) {
    throw serviceError(
      'Vital record was saved, but audit logging failed. Retry with the same idempotencyKey to avoid creating a duplicate.',
      503,
      { partialSuccess: true, vitalId: vital._id.toString() }
    );
  }
}

async function ensureAuditExists(vital, actorId) {
  let existingAudit;
  try {
    existingAudit = await AuditLog.findOne({
      actor: actorId,
      action: VITAL_AUDIT_ACTION,
      entityType: VITAL_ENTITY_TYPE,
      entityId: vital._id
    }).select('_id').lean();
  } catch (_) {
    throw serviceError('Unable to verify vital audit state', 500, {
      partialSuccess: true,
      vitalId: vital._id.toString()
    });
  }
  if (!existingAudit) await auditVital(vital, actorId);
}

async function recordVitals(input, user) {
  const doctor = await requireActiveDoctor(user);
  const data = validateVitalInput(input);
  const requestId = hashRequestKey(input.idempotencyKey, doctor.id);
  const encounter = await loadEncounter(data.encounter, data.patient);
  await authorizeEncounterAccess(doctor, encounter, 'Record vital signs');

  const existingVital = await findExistingVital(requestId);
  if (existingVital) {
    if (!sameVitalRequest(existingVital, data, doctor.id)) {
      throw serviceError('This idempotencyKey was already used for a different vital submission', 409);
    }
    await ensureAuditExists(existingVital, doctor.id);
    return { ...serializeVital(existingVital), replayed: true };
  }

  const vital = new Vital({
    _id: requestId,
    patient: data.patient,
    encounter: data.encounter,
    recordedBy: doctor.id,
    bloodPressure: data.bloodPressure,
    temperature: data.temperature,
    pulse: data.pulse,
    weight: data.weight,
    ...(data.height !== undefined ? { height: data.height } : {}),
    ...(data.oxygenSaturation !== undefined ? { oxygenSaturation: data.oxygenSaturation } : {}),
    recordedAt: new Date()
  });

  try {
    await vital.save();
  } catch (error) {
    if (error.code === 11000) {
      const concurrentVital = await findExistingVital(requestId);
      if (concurrentVital && sameVitalRequest(concurrentVital, data, doctor.id)) {
        await ensureAuditExists(concurrentVital, doctor.id);
        return { ...serializeVital(concurrentVital), replayed: true };
      }
      throw serviceError('Vital submission could not be saved safely', 409);
    }
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      throw serviceError('Vital measurements are invalid', 400);
    }
    throw serviceError('Unable to save vital measurements', 500);
  }

  await auditVital(vital, doctor.id);
  return serializeVital(vital);
}

async function getEncounterVitals(encounterId, user) {
  const doctor = await requireActiveDoctor(user);
  if (!validObjectId(encounterId)) throw serviceError('A valid encounter ID is required', 400);
  const encounter = await loadEncounter(new mongoose.Types.ObjectId(String(encounterId)));
  await authorizeEncounterAccess(doctor, encounter, 'Retrieve encounter vital signs');

  let vitals;
  try {
    vitals = await Vital.find({ encounter: encounter._id, patient: encounter.patient })
      .sort({ recordedAt: -1, _id: -1 })
      .lean();
  } catch (_) {
    throw serviceError('Unable to retrieve encounter vital signs', 500);
  }
  return vitals.map(serializeVital);
}

module.exports = {
  recordVitals,
  getEncounterVitals
};
