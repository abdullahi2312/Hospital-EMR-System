const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Patient = require('../models/Patient');
const PatientRegistrationOperation = require('../models/PatientRegistrationOperation');
const User = require('../models/User');
const { writeAuditLog } = require('./audit-log.service');

const MRN_COUNTER_ID = 'patient_mrn_sequence';
const MRN_PATTERN = /^MRN-(\d{6})$/;
const MAX_MRN_SEQUENCE = 999999;
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_PAGE_NUMBER = 1000000;
const REGISTRATION_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const REGISTRATION_LEASE_MS = 60 * 1000;

function createServiceError(message, status, properties = {}) {
  const error = new Error(message);
  error.name = 'PatientServiceError';
  error.status = status;
  error.statusCode = status;
  Object.assign(error, properties);
  return error;
}

function normalizeText(value, fieldName, maximumLength, required = false) {
  if (value === undefined || value === null) {
    if (required) {
      throw createServiceError(`${fieldName} is required`, 400);
    }
    return undefined;
  }

  if (typeof value !== 'string') {
    throw createServiceError(`${fieldName} must be text`, 400);
  }

  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if ((required && normalized.length === 0) || normalized.length > maximumLength) {
    throw createServiceError(`${fieldName} is invalid`, 400);
  }

  return normalized || undefined;
}

function normalizeDateOfBirth(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (!(value instanceof Date) && typeof value !== 'string') {
    throw createServiceError('Date of birth must be a valid date', 400);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw createServiceError('Date of birth must be a valid date', 400);
  }

  const isoDate = parsed.toISOString().slice(0, 10);
  const normalized = new Date(`${isoDate}T00:00:00.000Z`);
  const today = new Date();
  today.setUTCHours(23, 59, 59, 999);
  if (normalized > today) {
    throw createServiceError('Date of birth cannot be in the future', 400);
  }

  return normalized;
}

function normalizeEstimatedAge(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 150) {
    throw createServiceError('Estimated age must be a number from 0 to 150', 400);
  }

  return value;
}

function normalizePhone(value) {
  const phone = normalizeText(value, 'Phone number', 30);
  if (!phone) {
    return undefined;
  }

  const digits = phone.replace(/\D/g, '').replace(/^00/, '');
  if (!digits) {
    throw createServiceError('Phone number must contain digits', 400);
  }

  return { value: phone, comparisonKey: digits };
}

function normalizedName(patient) {
  return [patient.firstName, patient.fatherName, patient.grandfatherName]
    .map((part) => part.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en'))
    .join(' ');
}

function normalizedPhone(phone) {
  if (typeof phone !== 'string') {
    return '';
  }
  return phone.replace(/\D/g, '').replace(/^00/, '');
}

function buildPatientInput(input, registeredById) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw createServiceError('Patient registration input must be an object', 400);
  }

  const firstName = normalizeText(input.firstName, 'First name', 100, true);
  const fatherName = normalizeText(input.fatherName, 'Father name', 100, true);
  const grandfatherName = normalizeText(input.grandfatherName, 'Grandfather name', 100, true);
  const genderValue = input.sex ?? input.gender;
  const sex = normalizeText(genderValue, 'Sex', 10, true).toLowerCase();
  if (!['male', 'female'].includes(sex)) {
    throw createServiceError('Sex must be male or female', 400);
  }

  const dateOfBirth = normalizeDateOfBirth(input.dateOfBirth);
  const estimatedAge = normalizeEstimatedAge(input.estimatedAge);
  if (!dateOfBirth && estimatedAge === undefined) {
    throw createServiceError('Provide a date of birth or estimated age', 400);
  }

  const normalizedPhoneInput = normalizePhone(input.phone);
  const patientData = {
    firstName,
    fatherName,
    grandfatherName,
    sex,
    registeredBy: registeredById
  };

  if (dateOfBirth) patientData.dateOfBirth = dateOfBirth;
  if (estimatedAge !== undefined) patientData.estimatedAge = estimatedAge;
  if (normalizedPhoneInput) patientData.phone = normalizedPhoneInput.value;

  const district = normalizeText(input.district, 'District', 100);
  const emergencyContact = normalizeText(input.emergencyContact, 'Emergency contact', 100);
  if (district) patientData.district = district;
  if (emergencyContact) patientData.emergencyContact = emergencyContact;

  if (input.allergies !== undefined) {
    if (!Array.isArray(input.allergies)) {
      throw createServiceError('Allergies must be an array of text values', 400);
    }
    patientData.allergies = input.allergies.map((allergy) => (
      normalizeText(allergy, 'Allergy', 100, true)
    ));
  }

  if (input.allergyStatus !== undefined) {
    const allergyStatus = normalizeText(input.allergyStatus, 'Allergy status', 30, true);
    if (!['recorded', 'none_known', 'not_recorded'].includes(allergyStatus)) {
      throw createServiceError('Allergy status is invalid', 400);
    }
    patientData.allergyStatus = allergyStatus;
  }

  return {
    patientData,
    fullNameKey: normalizedName(patientData),
    dateOfBirth,
    phoneValue: normalizedPhoneInput?.value,
    phoneKey: normalizedPhoneInput?.comparisonKey,
    estimatedAge
  };
}

function normalizeRegistrationIdempotencyKey(value) {
  if (typeof value !== 'string') {
    throw createServiceError('A registration idempotencyKey is required', 400);
  }
  const key = value.trim();
  if (!REGISTRATION_KEY_PATTERN.test(key)) {
    throw createServiceError('Registration idempotencyKey must be 8 to 128 letters, numbers, or . _ : - characters', 400);
  }
  return key;
}

function identityHmac(value) {
  const secret = process.env.PATIENT_IDENTITY_HMAC_SECRET;
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw createServiceError('Patient idempotency protection is not configured', 503, {
      code: 'PATIENT_IDEMPOTENCY_NOT_CONFIGURED',
      retrySameKey: true
    });
  }
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function registrationFingerprint(registration) {
  const data = registration.patientData;
  const canonical = {
    firstName: data.firstName.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en'),
    fatherName: data.fatherName.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en'),
    grandfatherName: data.grandfatherName.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en'),
    sex: data.sex,
    dateOfBirth: registration.dateOfBirth ? registration.dateOfBirth.toISOString().slice(0, 10) : null,
    estimatedAge: registration.estimatedAge ?? null,
    phone: registration.phoneKey || null,
    district: data.district || null,
    emergencyContact: data.emergencyContact || null,
    allergies: data.allergies || [],
    allergyStatus: data.allergyStatus || 'not_recorded'
  };
  return identityHmac(`patient-registration-input:${JSON.stringify(canonical)}`);
}

function registrationKeyHash(actorId, key) {
  return crypto.createHash('sha256').update(`patient-registration:${actorId}:${key}`).digest('hex');
}

function registrationAuditKey(actorId, keyHash) {
  return identityHmac(`patient-registration-audit:${actorId}:${keyHash}`);
}

function operationSelect(query) {
  return query
    .select('+idempotencyKeyHash +inputFingerprint +auditDeduplicationKey +leaseToken')
    .lean();
}

async function findRegistrationOperation(actorId, keyHash) {
  try {
    return await operationSelect(PatientRegistrationOperation.findOne({ actor: actorId, idempotencyKeyHash: keyHash }));
  } catch (_) {
    throw createServiceError('Unable to verify patient registration retry', 503);
  }
}

async function createRegistrationOperation(values) {
  const operation = new PatientRegistrationOperation(values);
  try {
    await operation.save();
    return operation.toObject ? operation.toObject() : operation;
  } catch (error) {
    if (error.code !== 11000) {
      if (error.name === 'ValidationError' || error.name === 'CastError') {
        throw createServiceError('Patient registration operation is invalid', 400);
      }
      throw createServiceError('Unable to reserve patient registration request', 503);
    }
    const existing = await findRegistrationOperation(String(values.actor), values.idempotencyKeyHash);
    if (!existing) throw createServiceError('Unable to confirm patient registration retry', 503);
    return existing;
  }
}

async function updateRegistrationOperation(operation, filter, values) {
  try {
    const setValues = { ...values };
    const update = { $set: setValues };
    if (setValues.leaseToken === null) {
      delete setValues.leaseToken;
      update.$unset = { leaseToken: 1 };
    }
    const result = await PatientRegistrationOperation.updateOne(
      { _id: operation._id, ...filter },
      update,
      { runValidators: true }
    );
    if ((result.matchedCount ?? result.n ?? 0) === 0) {
      const latest = await findRegistrationOperation(String(operation.actor), operation.idempotencyKeyHash);
      if (latest && latest.status === 'created' && String(latest.patient) === String(operation.patient)) {
        Object.assign(operation, latest);
        return;
      }
      throw createServiceError('Patient registration operation changed; retry with the same idempotencyKey', 409, {
        code: 'PATIENT_REGISTRATION_STATE_CHANGED',
        retrySameKey: true
      });
    }
    Object.assign(operation, values);
    if (values.leaseToken === null) delete operation.leaseToken;
  } catch (error) {
    if (error.name === 'PatientServiceError') throw error;
    throw createServiceError('Unable to update patient registration retry state', 503);
  }
}

async function claimRegistrationOperation(operation) {
  const now = new Date();
  const leaseToken = crypto.randomBytes(24).toString('hex');
  try {
    const claimQuery = PatientRegistrationOperation.findOneAndUpdate(
      {
        _id: operation._id,
        $or: [
          { status: 'pending' },
          { status: 'creating', leaseUntil: { $lte: now } }
        ]
      },
      {
        $set: {
          status: 'creating',
          leaseToken,
          leaseUntil: new Date(now.getTime() + REGISTRATION_LEASE_MS)
        }
      },
      { new: true, runValidators: true }
    );
    const claimed = await operationSelect(claimQuery);
    if (!claimed) return null;
    return claimed;
  } catch (_) {
    throw createServiceError('Unable to reserve patient registration processing', 503);
  }
}

async function loadOperationPatient(patientId) {
  try {
    return await Patient.findById(String(patientId))
      .select('_id mrn firstName fatherName grandfatherName createdAt')
      .lean();
  } catch (_) {
    throw createServiceError('Unable to retrieve the registered patient', 503);
  }
}

async function recordPatientRegistrationAudit(operation) {
  if (operation.auditCompleted === true) return;
  try {
    await writeAuditLog({
      actorId: operation.actor,
      action: 'patient_registered',
      entityType: 'Patient',
      entityId: operation.patient,
      patientRegistrationDeduplicationKey: operation.auditDeduplicationKey
    });
  } catch (_) {
    throw createServiceError(
      'Patient registration was saved, but audit logging failed. Retry with the same idempotencyKey to finish audit recovery without creating another patient.',
      503,
      { partialSuccess: true, patientCreated: true, auditWritten: false, patientId: String(operation.patient) }
    );
  }
  try {
    await updateRegistrationOperation(operation, { status: 'created' }, { auditCompleted: true });
  } catch (_) {
    // The unique audit key makes this safe to repair on the next retry.
    throw createServiceError(
      'Patient registration and audit may already have succeeded. Retry with the same idempotencyKey to verify completion.',
      503,
      { partialSuccess: true, patientCreated: true, auditWritten: true, patientId: String(operation.patient) }
    );
  }
}

async function verifyRegistrar(registeredBy) {
  if (!registeredBy || typeof registeredBy !== 'object' || !mongoose.isObjectIdOrHexString(registeredBy.id)) {
    throw createServiceError('A valid authenticated registrar is required', 401);
  }

  let registrar;
  try {
    registrar = await User.findById(String(registeredBy.id))
      .select('_id role isActive')
      .lean();
  } catch (_) {
    throw createServiceError('Unable to verify patient registrar', 500);
  }

  if (!registrar) {
    throw createServiceError('Authenticated registrar no longer exists', 401);
  }

  if (!['receptionist', 'admin'].includes(registrar.role) || registrar.isActive !== true) {
    throw createServiceError('Only active receptionists and administrators may register patients', 403);
  }

  return registrar;
}

async function findDuplicatePatient(registration) {
  const lookups = [];

  if (registration.dateOfBirth) {
    const nextDay = new Date(registration.dateOfBirth.getTime() + 24 * 60 * 60 * 1000);
    lookups.push(
      Patient.find({
        dateOfBirth: { $gte: registration.dateOfBirth, $lt: nextDay }
      })
        .select('firstName fatherName grandfatherName')
        .lean()
    );
  } else {
    lookups.push(Promise.resolve([]));
  }

  if (!registration.dateOfBirth && registration.estimatedAge !== undefined) {
    lookups.push(
      Patient.find({
        estimatedAge: registration.estimatedAge,
        sex: registration.patientData.sex,
        $or: [{ dateOfBirth: { $exists: false } }, { dateOfBirth: null }]
      })
        .select('firstName fatherName grandfatherName')
        .lean()
    );
  } else {
    lookups.push(Promise.resolve([]));
  }

  if (registration.phoneKey) {
    lookups.push(
      Patient.find({ phone: { $exists: true, $ne: '' } })
        .select('phone')
        .lean()
    );
  } else {
    lookups.push(Promise.resolve([]));
  }

  const [sameDayPatients, sameEstimatedAgePatients, patientsWithPhone] = await Promise.all(lookups);
  const sameNameAndDob = sameDayPatients.some((patient) => (
    normalizedName(patient) === registration.fullNameKey
  ));
  const possibleSameNameAndAge = sameEstimatedAgePatients.some((patient) => (
    normalizedName(patient) === registration.fullNameKey
  ));
  const samePhone = patientsWithPhone.some((patient) => (
    normalizedPhone(patient.phone) === registration.phoneKey
  ));

  return sameNameAndDob || possibleSameNameAndAge || samePhone;
}

async function nextMrn() {
  const database = mongoose.connection.db;
  if (!database) {
    throw createServiceError('Database is not connected', 503);
  }

  const counters = database.collection('hospital_emr_sequences');
  let counter;
  try {
    counter = await counters.findOne({ _id: MRN_COUNTER_ID });
    if (!counter) {
      const latestPatient = await Patient.findOne({ mrn: /^MRN-\d{6}$/ })
        .sort({ mrn: -1 })
        .select('mrn')
        .lean();
      const match = latestPatient?.mrn?.match(MRN_PATTERN);
      const initialSequence = match ? Number(match[1]) : 0;

      try {
        await counters.insertOne({ _id: MRN_COUNTER_ID, sequence: initialSequence });
      } catch (error) {
        if (error.code !== 11000) {
          throw error;
        }
      }
    }

    const result = await counters.findOneAndUpdate(
      { _id: MRN_COUNTER_ID },
      { $inc: { sequence: 1 } },
      { upsert: true, returnDocument: 'after', includeResultMetadata: false }
    );
    const updatedCounter = result?.value ?? result;
    const sequence = updatedCounter?.sequence;

    if (!Number.isInteger(sequence) || sequence < 1 || sequence > MAX_MRN_SEQUENCE) {
      throw createServiceError('Patient MRN sequence is unavailable or exhausted', 503);
    }

    return `MRN-${String(sequence).padStart(6, '0')}`;
  } catch (error) {
    if (error.name === 'PatientServiceError') {
      throw error;
    }
    throw createServiceError('Unable to generate a patient MRN', 500);
  }
}

function isDuplicateMrnError(error) {
  return error.code === 11000 && (
    error.keyPattern?.mrn === 1 ||
    Object.prototype.hasOwnProperty.call(error.keyValue || {}, 'mrn')
  );
}

const PATIENT_IDENTITY_KEY_FIELDS = [
  'identityNameDobKey',
  'identityNameEstimatedAgeKey',
  'identityPhoneKey'
];

function isDuplicatePatientIdentityError(error) {
  if (error?.code !== 11000) return false;
  const keyPattern = error.keyPattern || {};
  const keyValue = error.keyValue || {};
  return PATIENT_IDENTITY_KEY_FIELDS.some((field) => (
    Object.prototype.hasOwnProperty.call(keyPattern, field) ||
    Object.prototype.hasOwnProperty.call(keyValue, field)
  )) || /unique_patient_normalized_(?:name_dob|name_estimated_age|phone)/i.test(error.message || '');
}

function toSafeRegistrationResult(patient) {
  return {
    id: patient._id.toString(),
    mrn: patient.mrn,
    fullName: [patient.firstName, patient.fatherName, patient.grandfatherName].join(' '),
    registeredAt: patient.createdAt
  };
}

function requireDirectoryRole(user, allowedRoles) {
  if (!user || typeof user !== 'object' || !mongoose.isObjectIdOrHexString(user.id)) {
    throw createServiceError('Authentication required', 401);
  }

  if (!allowedRoles.includes(user.role)) {
    throw createServiceError('You do not have permission to view patient directory information', 403);
  }
}

function parsePositiveInteger(value, field, defaultValue, maximum) {
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw createServiceError(`${field} must be a positive whole number`, 400);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw createServiceError(`${field} must be between 1 and ${maximum}`, 400);
  }

  return parsed;
}

function normalizeSearch(value) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw createServiceError('Search must be text', 400);
  }

  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (normalized.length > 100) {
    throw createServiceError('Search cannot exceed 100 characters', 400);
  }

  return normalized || undefined;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPatientSearchFilter(search) {
  if (!search) {
    return {};
  }

  const escaped = escapeRegex(search);
  const regex = { $regex: escaped, $options: 'i' };

  return {
    $or: [
      { mrn: regex },
      { firstName: regex },
      { fatherName: regex },
      { grandfatherName: regex },
      {
        $expr: {
          $regexMatch: {
            input: {
              $concat: [
                { $ifNull: ['$firstName', ''] },
                ' ',
                { $ifNull: ['$fatherName', ''] },
                ' ',
                { $ifNull: ['$grandfatherName', ''] }
              ]
            },
            regex: escaped,
            options: 'i'
          }
        }
      }
    ]
  };
}

function toPatientListItem(patient) {
  return {
    id: patient._id.toString(),
    mrn: patient.mrn,
    firstName: patient.firstName,
    fatherName: patient.fatherName,
    grandfatherName: patient.grandfatherName,
    sex: patient.sex,
    registeredAt: patient.createdAt
  };
}

function toPatientIdentity(patient) {
  return {
    id: patient._id.toString(),
    mrn: patient.mrn,
    firstName: patient.firstName,
    fatherName: patient.fatherName,
    grandfatherName: patient.grandfatherName,
    sex: patient.sex,
    ...(patient.dateOfBirth ? { dateOfBirth: patient.dateOfBirth } : {}),
    ...(patient.estimatedAge !== undefined ? { estimatedAge: patient.estimatedAge } : {}),
    registeredAt: patient.createdAt
  };
}

async function listPatients(query, user) {
  requireDirectoryRole(user, ['receptionist', 'admin']);

  const page = parsePositiveInteger(query?.page, 'Page', DEFAULT_PAGE, MAX_PAGE_NUMBER);
  const limit = parsePositiveInteger(query?.limit, 'Limit', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const search = normalizeSearch(query?.search);
  const filter = buildPatientSearchFilter(search);
  const skip = (page - 1) * limit;

  let patients;
  let total;
  try {
    [patients, total] = await Promise.all([
      Patient.find(filter)
        .select('_id mrn firstName fatherName grandfatherName sex createdAt')
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Patient.countDocuments(filter)
    ]);
  } catch (_) {
    throw createServiceError('Unable to retrieve patient directory', 500);
  }

  try {
    await writeAuditLog({
      actorId: user.id,
      action: 'patient_directory_listed',
      entityType: 'Patient',
      details: { page, limit, searchApplied: Boolean(search) }
    });
  } catch (_) {
    throw createServiceError('Unable to record patient directory access', 500);
  }

  return {
    patients: patients.map(toPatientListItem),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  };
}

async function getPatientDetails(patientId, user) {
  requireDirectoryRole(user, ['receptionist', 'admin', 'patient']);

  if (!mongoose.isObjectIdOrHexString(patientId)) {
    throw createServiceError('A valid patient ID is required', 400);
  }

  const normalizedPatientId = new mongoose.Types.ObjectId(String(patientId)).toString();
  if (user.role === 'patient') {
    const linkedPatientId = mongoose.isObjectIdOrHexString(user.patient)
      ? new mongoose.Types.ObjectId(String(user.patient)).toString()
      : undefined;
    if (linkedPatientId !== normalizedPatientId) {
      throw createServiceError('You do not have permission to view this patient', 403);
    }
  }

  let patient;
  try {
    patient = await Patient.findById(normalizedPatientId)
      .select('_id mrn firstName fatherName grandfatherName sex dateOfBirth estimatedAge createdAt')
      .lean();
  } catch (_) {
    throw createServiceError('Unable to retrieve patient identity details', 500);
  }

  if (!patient) {
    throw createServiceError('Patient not found', 404);
  }

  try {
    await writeAuditLog({
      actorId: user.id,
      action: 'patient_identity_viewed',
      entityType: 'Patient',
      entityId: patient._id,
      details: { viewType: 'identity' }
    });
  } catch (_) {
    throw createServiceError('Unable to record patient directory access', 500);
  }

  return toPatientIdentity(patient);
}

async function findOperationPatient(operation) {
  const patient = await loadOperationPatient(operation.patient);
  return patient;
}

async function markOperationCreated(operation) {
  if (operation.status === 'created') return;
  await updateRegistrationOperation(
    operation,
    { status: { $in: ['pending', 'creating'] } },
    { status: 'created', leaseToken: null, leaseUntil: null, auditCompleted: false }
  );
}

async function finishExistingPatientOperation(operation, patient) {
  if (!patient) throw createServiceError('The patient registration result is unavailable', 503);
  await markOperationCreated(operation);
  await recordPatientRegistrationAudit(operation);
  return toSafeRegistrationResult(patient);
}

async function waitForRegistrationInProgress(operation, registration) {
  const maximumAttempts = 40;
  const pollIntervalMs = 25;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const latest = await findRegistrationOperation(String(operation.actor), operation.idempotencyKeyHash);
    if (!latest) throw createServiceError('Unable to verify patient registration retry', 503);
    if (latest.inputFingerprint !== operation.inputFingerprint) {
      throw createServiceError('This idempotencyKey was already used for different patient registration data', 409);
    }
    if (latest.status === 'duplicate_rejected') {
      throw createServiceError('A possible duplicate patient exists; review existing records before registering', 409);
    }
    const patient = await findOperationPatient(latest);
    if (patient) return finishExistingPatientOperation(latest, patient);
    if (latest.status === 'created') {
      throw createServiceError('Patient registration state is inconsistent; retry with the same idempotencyKey', 503);
    }

    const leaseExpired = latest.status === 'pending' ||
      (latest.status === 'creating' && (!latest.leaseUntil || new Date(latest.leaseUntil) <= new Date()));
    if (leaseExpired) return continuePatientRegistration(latest, registration);
  }
  throw createServiceError('Patient registration is still processing. Retry with the same idempotencyKey.', 409, {
    code: 'PATIENT_REGISTRATION_IN_PROGRESS',
    retrySameKey: true
  });
}

async function continuePatientRegistration(operation, registration) {
  if (operation.status === 'duplicate_rejected') {
    throw createServiceError('A possible duplicate patient exists; review existing records before registering', 409);
  }

  const existingPatient = await findOperationPatient(operation);
  if (existingPatient) return finishExistingPatientOperation(operation, existingPatient);
  if (operation.status === 'created') {
    throw createServiceError('Patient registration state is inconsistent; retry with the same idempotencyKey', 503);
  }

  let claimed = operation;
  if (operation.status !== 'creating' || !operation.leaseUntil || new Date(operation.leaseUntil) <= new Date()) {
    claimed = await claimRegistrationOperation(operation);
    if (!claimed) {
      const latest = await findRegistrationOperation(String(operation.actor), operation.idempotencyKeyHash);
      if (!latest) throw createServiceError('Unable to verify patient registration retry', 503);
      const patient = await findOperationPatient(latest);
      if (patient) return finishExistingPatientOperation(latest, patient);
      return waitForRegistrationInProgress(latest, registration);
    }
  } else {
    return waitForRegistrationInProgress(operation, registration);
  }

  const patientAfterClaim = await findOperationPatient(claimed);
  if (patientAfterClaim) return finishExistingPatientOperation(claimed, patientAfterClaim);
  if (!registration) {
    throw createServiceError('Patient registration input is unavailable; retry with the same idempotencyKey', 503);
  }

  let duplicate;
  try {
    duplicate = await findDuplicatePatient(registration);
  } catch (_) {
    throw createServiceError('Unable to check for duplicate patient records', 500);
  }
  if (duplicate) {
    await updateRegistrationOperation(
      claimed,
      { status: 'creating', leaseToken: claimed.leaseToken },
      { status: 'duplicate_rejected', leaseToken: null, leaseUntil: null }
    );
    throw createServiceError('A possible duplicate patient exists; review existing records before registering', 409);
  }

  const patient = new Patient({
    ...registration.patientData,
    _id: claimed.patient,
    mrn: 'MRN-000001'
  });
  try {
    await patient.validate();
  } catch (error) {
    if (error.name === 'PatientIdentityConfigurationError') {
      throw createServiceError('Patient idempotency protection is not configured', 503, {
        code: 'PATIENT_IDEMPOTENCY_NOT_CONFIGURED',
        retrySameKey: true
      });
    }
    throw createServiceError('Patient registration data is invalid', 400);
  }

  let savedPatient;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    patient.mrn = await nextMrn();
    try {
      savedPatient = await patient.save();
      break;
    } catch (error) {
      if (isDuplicatePatientIdentityError(error)) {
        await updateRegistrationOperation(
          claimed,
          { status: 'creating', leaseToken: claimed.leaseToken },
          { status: 'duplicate_rejected', leaseToken: null, leaseUntil: null }
        );
        throw createServiceError('A possible duplicate patient exists; review existing records before registering', 409);
      }
      if (isDuplicateMrnError(error)) continue;
      if (error.code === 11000) {
        const alreadySaved = await findOperationPatient(claimed);
        if (alreadySaved) return finishExistingPatientOperation(claimed, alreadySaved);
      }
      if (error.name === 'ValidationError' || error.name === 'CastError') {
        throw createServiceError('Patient registration data is invalid', 400);
      }
      throw createServiceError('Unable to register patient. Retry with the same idempotencyKey.', 503);
    }
  }

  if (!savedPatient) throw createServiceError('Unable to allocate a unique patient MRN', 503);

  await updateRegistrationOperation(
    claimed,
    { status: 'creating', leaseToken: claimed.leaseToken },
    { status: 'created', leaseToken: null, leaseUntil: null, auditCompleted: false }
  );
  await recordPatientRegistrationAudit(claimed);
  return toSafeRegistrationResult(savedPatient);
}

async function registerPatient(input, registeredBy) {
  const registrar = await verifyRegistrar(registeredBy);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw createServiceError('Patient registration input must be an object', 400);
  }
  const idempotencyKey = normalizeRegistrationIdempotencyKey(input.idempotencyKey);
  const registration = buildPatientInput(input, registrar._id);
  const fingerprint = registrationFingerprint(registration);
  const keyHash = registrationKeyHash(String(registrar._id), idempotencyKey);

  let operation = await findRegistrationOperation(String(registrar._id), keyHash);
  if (operation) {
    if (operation.inputFingerprint !== fingerprint) {
      throw createServiceError('This idempotencyKey was already used for different patient registration data', 409);
    }
    if (operation.status === 'duplicate_rejected') {
      throw createServiceError('A possible duplicate patient exists; review existing records before registering', 409);
    }
    return continuePatientRegistration(operation, registration);
  }

  let duplicate;
  try {
    duplicate = await findDuplicatePatient(registration);
  } catch (_) {
    throw createServiceError('Unable to check for duplicate patient records', 500);
  }
  if (duplicate) {
    throw createServiceError('A possible duplicate patient exists; review existing records before registering', 409);
  }

  const operationValues = {
    actor: registrar._id,
    idempotencyKeyHash: keyHash,
    inputFingerprint: fingerprint,
    auditDeduplicationKey: registrationAuditKey(String(registrar._id), keyHash),
    patient: new mongoose.Types.ObjectId(),
    status: 'pending',
    auditCompleted: false
  };
  operation = await createRegistrationOperation(operationValues);
  if (operation.inputFingerprint !== fingerprint) {
    throw createServiceError('This idempotencyKey was already used for different patient registration data', 409);
  }
  if (operation.status === 'duplicate_rejected') {
    throw createServiceError('A possible duplicate patient exists; review existing records before registering', 409);
  }
  return continuePatientRegistration(operation, registration);
}

module.exports = {
  registerPatient,
  listPatients,
  getPatientDetails
};
