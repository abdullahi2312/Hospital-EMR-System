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
const VITAL_INPUT_FIELDS = new Set([
  'patient', 'encounter', 'bloodPressure', 'temperature', 'pulse', 'heartRate',
  'respiratoryRate', 'weight', 'height', 'oxygenSaturation', 'idempotencyKey'
]);
const VITAL_UNITS = Object.freeze({
  bloodPressure: 'mmHg',
  heartRate: 'beats/min',
  pulse: 'beats/min',
  respiratoryRate: 'breaths/min',
  temperature: '°C',
  oxygenSaturation: '%',
  weight: 'kg',
  height: 'cm'
});

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
    heightMax: readLimit('VITAL_MAX_HEIGHT_CM', 300, 250, 350),
    respiratoryRateMin: readLimit('VITAL_MIN_RESPIRATORY_RATE_PER_MIN', 1, 1, 20),
    respiratoryRateMax: readLimit('VITAL_MAX_RESPIRATORY_RATE_PER_MIN', 100, 30, 150),
    oxygenSaturationMin: readLimit('VITAL_MIN_SPO2_PERCENT', 1, 1, 50)
  };
  if (
    limits.temperatureMin >= limits.temperatureMax ||
    limits.pulseMin >= limits.pulseMax ||
    limits.systolicMin >= limits.systolicMax ||
    limits.diastolicMin >= limits.diastolicMax ||
    limits.weightMin >= limits.weightMax ||
    limits.heightMin >= limits.heightMax ||
    limits.respiratoryRateMin >= limits.respiratoryRateMax
  ) {
    throw serviceError('Vital limit configuration is invalid', 500);
  }
  return limits;
}

// Configurable adult reference thresholds for flagging only; they are not diagnostic cutoffs.
function abnormalReferenceThresholds() {
  const thresholds = {
    systolicLow: readLimit('VITAL_FLAG_SYSTOLIC_LOW_MMHG', 90, 40, 180),
    systolicHigh: readLimit('VITAL_FLAG_SYSTOLIC_HIGH_MMHG', 180, 90, 300),
    diastolicLow: readLimit('VITAL_FLAG_DIASTOLIC_LOW_MMHG', 60, 20, 120),
    diastolicHigh: readLimit('VITAL_FLAG_DIASTOLIC_HIGH_MMHG', 120, 60, 200),
    temperatureLow: readLimit('VITAL_FLAG_TEMPERATURE_LOW_C', 36, 30, 40),
    temperatureHigh: readLimit('VITAL_FLAG_TEMPERATURE_HIGH_C', 38, 35, 45),
    heartRateLow: readLimit('VITAL_FLAG_HEART_RATE_LOW_BPM', 50, 1, 100),
    heartRateHigh: readLimit('VITAL_FLAG_HEART_RATE_HIGH_BPM', 120, 50, 300),
    respiratoryRateLow: readLimit('VITAL_FLAG_RESPIRATORY_RATE_LOW_PER_MIN', 12, 1, 60),
    respiratoryRateHigh: readLimit('VITAL_FLAG_RESPIRATORY_RATE_HIGH_PER_MIN', 20, 12, 100),
    oxygenSaturationLow: readLimit('VITAL_FLAG_SPO2_LOW_PERCENT', 92, 50, 99)
  };
  if (thresholds.systolicLow >= thresholds.systolicHigh ||
      thresholds.diastolicLow >= thresholds.diastolicHigh ||
      thresholds.temperatureLow >= thresholds.temperatureHigh ||
      thresholds.heartRateLow >= thresholds.heartRateHigh ||
      thresholds.respiratoryRateLow >= thresholds.respiratoryRateHigh) {
    throw serviceError('Vital reference threshold configuration is invalid', 500);
  }
  return thresholds;
}

function validateVitalInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw serviceError('Vital input must be an object');
  }
  if (Object.keys(input).some((field) => !VITAL_INPUT_FIELDS.has(field))) {
    throw serviceError('Vital input contains unsupported or server-managed fields');
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
  if (Object.keys(sourceBloodPressure).some((field) => !['systolic', 'diastolic'].includes(field))) {
    throw serviceError('Blood pressure may contain only systolic and diastolic values');
  }
  const systolic = finiteNumber(sourceBloodPressure.systolic, 'Systolic blood pressure (mmHg)');
  const diastolic = finiteNumber(sourceBloodPressure.diastolic, 'Diastolic blood pressure (mmHg)');
  const temperature = finiteNumber(input.temperature, 'Temperature (°C)');
  const pulseValue = input.pulse ?? input.heartRate;
  if (input.pulse !== undefined && input.heartRate !== undefined && input.pulse !== input.heartRate) {
    throw serviceError('Pulse and heartRate values must match when both are supplied');
  }
  const pulse = finiteNumber(pulseValue, 'Heart rate (beats/min)');
  const respiratoryRate = input.respiratoryRate === undefined
    ? undefined
    : finiteNumber(input.respiratoryRate, 'Respiratory rate (breaths/min)');
  const weight = finiteNumber(input.weight, 'Weight (kg)');
  const height = input.height === undefined ? undefined : finiteNumber(input.height, 'Height (cm)');
  const oxygenSaturation = input.oxygenSaturation === undefined
    ? undefined
    : finiteNumber(input.oxygenSaturation, 'Oxygen saturation (SpO2 %)');

  if (systolic < limits.systolicMin || systolic > limits.systolicMax) {
    throw serviceError(`Systolic blood pressure must be between ${limits.systolicMin} and ${limits.systolicMax} mmHg`);
  }
  if (diastolic < limits.diastolicMin || diastolic > limits.diastolicMax) {
    throw serviceError(`Diastolic blood pressure must be between ${limits.diastolicMin} and ${limits.diastolicMax} mmHg`);
  }
  if (systolic <= diastolic) {
    throw serviceError('Systolic blood pressure must be greater than diastolic blood pressure');
  }
  if (temperature < limits.temperatureMin || temperature > limits.temperatureMax) {
    throw serviceError(`Temperature must be between ${limits.temperatureMin} and ${limits.temperatureMax} °C`);
  }
  if (pulse < limits.pulseMin || pulse > limits.pulseMax) {
    throw serviceError(`Heart rate must be between ${limits.pulseMin} and ${limits.pulseMax} beats per minute`);
  }
  if (weight < limits.weightMin || weight > limits.weightMax) {
    throw serviceError(`Weight must be between ${limits.weightMin} and ${limits.weightMax} kg`);
  }
  if (height !== undefined && (height < limits.heightMin || height > limits.heightMax)) {
    throw serviceError(`Height must be between ${limits.heightMin} and ${limits.heightMax} cm`);
  }
  if (respiratoryRate !== undefined && (respiratoryRate < limits.respiratoryRateMin || respiratoryRate > limits.respiratoryRateMax)) {
    throw serviceError(`Respiratory rate must be between ${limits.respiratoryRateMin} and ${limits.respiratoryRateMax} breaths per minute`);
  }
  if (oxygenSaturation !== undefined && (oxygenSaturation < limits.oxygenSaturationMin || oxygenSaturation > 100)) {
    throw serviceError(`Oxygen saturation must be between ${limits.oxygenSaturationMin} and 100 percent`);
  }

  return {
    patient: new mongoose.Types.ObjectId(String(input.patient)),
    encounter: new mongoose.Types.ObjectId(String(input.encounter)),
    bloodPressure: { systolic, diastolic },
    temperature,
    pulse,
    ...(respiratoryRate !== undefined ? { respiratoryRate } : {}),
    weight,
    ...(height !== undefined ? { height } : {}),
    ...(oxygenSaturation !== undefined ? { oxygenSaturation } : {}),
    limits
  };
}

function getAbnormalFlags(vital) {
  const flags = [];
  const thresholds = abnormalReferenceThresholds();
  const bp = vital.bloodPressure;
  if (bp.systolic < thresholds.systolicLow) flags.push({ measurement: 'systolic', status: 'low' });
  if (bp.systolic > thresholds.systolicHigh) flags.push({ measurement: 'systolic', status: 'high' });
  if (bp.diastolic < thresholds.diastolicLow) flags.push({ measurement: 'diastolic', status: 'low' });
  if (bp.diastolic > thresholds.diastolicHigh) flags.push({ measurement: 'diastolic', status: 'high' });
  if (vital.temperature < thresholds.temperatureLow) flags.push({ measurement: 'temperature', status: 'low' });
  if (vital.temperature > thresholds.temperatureHigh) flags.push({ measurement: 'temperature', status: 'high' });
  if (vital.pulse < thresholds.heartRateLow) flags.push({ measurement: 'pulse', status: 'low' });
  if (vital.pulse > thresholds.heartRateHigh) flags.push({ measurement: 'pulse', status: 'high' });
  if (vital.respiratoryRate !== undefined && vital.respiratoryRate < thresholds.respiratoryRateLow) {
    flags.push({ measurement: 'respiratoryRate', status: 'low' });
  }
  if (vital.respiratoryRate !== undefined && vital.respiratoryRate > thresholds.respiratoryRateHigh) {
    flags.push({ measurement: 'respiratoryRate', status: 'high' });
  }
  if (vital.oxygenSaturation !== undefined && vital.oxygenSaturation < thresholds.oxygenSaturationLow) {
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
    heartRate: vital.pulse,
    ...(vital.respiratoryRate !== undefined ? { respiratoryRate: vital.respiratoryRate } : {}),
    weight: vital.weight,
    ...(vital.height !== undefined ? { height: vital.height } : {}),
    ...(vital.oxygenSaturation !== undefined ? { oxygenSaturation: vital.oxygenSaturation } : {}),
    recordedAt: vital.recordedAt,
    abnormalFlags: getAbnormalFlags(vital),
    units: VITAL_UNITS
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
    vital.respiratoryRate === data.respiratoryRate &&
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
    ...(data.respiratoryRate !== undefined ? { respiratoryRate: data.respiratoryRate } : {}),
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
