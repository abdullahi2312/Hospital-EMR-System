const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog');
const Consent = require('../models/Consent');
const Patient = require('../models/Patient');
const User = require('../models/User');
const { writeAuditLog } = require('./audit-log.service');
const { createNotificationOnce } = require('./notification.service');

const CONSENT_SCOPE = 'clinical_record';
const GRANT_ACTION = 'patient_consent_granted';
const REVOKE_ACTION = 'patient_consent_revoked';
const auditWrites = new Map();

function consentError(message, status = 400, properties = {}) {
  const error = new Error(message);
  error.name = 'ConsentServiceError';
  error.status = status;
  error.statusCode = status;
  Object.assign(error, properties);
  return error;
}

function validObjectId(value) {
  return mongoose.isObjectIdOrHexString(value);
}

function validateInput(input, allowedFields) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw consentError('Consent input must be an object');
  }
  if (Object.keys(input).some((field) => !allowedFields.has(field))) {
    throw consentError('Consent input contains unsupported or server-managed fields');
  }
}

function normalizeNotes(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw consentError('Consent notes must be text');
  const notes = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (notes.length > 2000) throw consentError('Consent notes cannot exceed 2000 characters');
  return notes || undefined;
}

async function requireActivePatientAccount(user) {
  if (!user || typeof user !== 'object' || !validObjectId(user.id)) {
    throw consentError('Authentication required', 401);
  }

  let account;
  try {
    account = await User.findById(String(user.id)).select('_id role patient isActive').lean();
  } catch (_) {
    throw consentError('Unable to verify patient account', 500);
  }

  if (!account || account.isActive !== true) {
    throw consentError('Authentication required', 401);
  }
  if (account.role !== 'patient') {
    throw consentError('Only active patient portal accounts may manage consent', 403);
  }
  if (!validObjectId(account.patient)) {
    throw consentError('Patient portal account is not linked to a valid patient record', 403);
  }

  let patientExists;
  try {
    patientExists = await Patient.exists({ _id: account.patient });
  } catch (_) {
    throw consentError('Unable to verify linked patient record', 500);
  }
  if (!patientExists) {
    throw consentError('Patient portal account is not linked to an existing patient record', 403);
  }

  return { account, patientId: account.patient };
}

function serializeConsent(consent, replayed = false) {
  return {
    id: consent._id.toString(),
    patient: consent.patient.toString(),
    doctor: consent.doctor.toString(),
    scope: consent.scope,
    status: consent.status,
    grantedAt: consent.grantedAt,
    ...(consent.revokedAt ? { revokedAt: consent.revokedAt } : {}),
    createdAt: consent.createdAt,
    updatedAt: consent.updatedAt,
    ...(replayed ? { replayed: true } : {})
  };
}

async function findAudit(actorId, action, consentId) {
  try {
    return await AuditLog.findOne({
      actor: actorId,
      action,
      entityType: 'Consent',
      entityId: consentId
    }).select('_id').lean();
  } catch (_) {
    throw consentError('Consent may have been saved, but its audit status could not be verified', 503, {
      partialSuccess: true,
      consentId: String(consentId)
    });
  }
}

async function ensureConsentAudit(actorId, action, consentId) {
  const key = `${actorId}:${action}:${consentId}`;
  if (auditWrites.has(key)) return auditWrites.get(key);

  const write = (async () => {
    const existing = await findAudit(actorId, action, consentId);
    if (existing) return;
    try {
      await writeAuditLog({
        actorId,
        action,
        entityType: 'Consent',
        entityId: consentId
      });
    } catch (_) {
      throw consentError('Consent was saved, but audit logging failed. Retry the same operation to recover audit logging.', 503, {
        partialSuccess: true,
        consentId: String(consentId)
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

async function ensureConsentNotification(consent, event) {
  let doctor;
  try {
    doctor = await User.findById(String(consent.doctor)).select('_id isActive').lean();
  } catch (_) {
    throw consentError('Consent changed, but notification status could not be verified', 503, {
      partialSuccess: true,
      notificationFailure: true,
      consentId: String(consent._id)
    });
  }
  if (!doctor || doctor.isActive !== true) return;
  try {
    await createNotificationOnce({
      recipient: doctor._id,
      patient: consent.patient,
      type: 'general',
      title: 'Patient consent updated',
      message: event === 'granted'
        ? 'A patient updated access permissions in the EMR.'
        : 'A patient revoked access permissions. The change is effective immediately.',
      relatedModel: 'Consent',
      relatedId: consent._id,
      eventKey: `patient-consent-${event}:${consent._id}`
    });
  } catch (_) {
    throw consentError('Consent changed, but its notification could not be completed. Retry the same operation to recover the notice.', 503, {
      partialSuccess: true,
      notificationFailure: true,
      consentId: String(consent._id)
    });
  }
}

async function findActiveConsent(patientId, doctorId, scope) {
  try {
    return await Consent.findOne({
      patient: patientId,
      doctor: doctorId,
      scope,
      status: 'granted'
    }).lean();
  } catch (_) {
    throw consentError('Unable to check existing consent', 500);
  }
}

async function grantPatientConsent(input, user) {
  validateInput(input, new Set(['doctorId', 'scope', 'notes']));
  if (!validObjectId(input.doctorId)) throw consentError('A valid doctor ID is required');
  const scope = input.scope === undefined ? CONSENT_SCOPE : input.scope;
  if (scope !== CONSENT_SCOPE) throw consentError('Consent scope must be clinical_record');
  const notes = normalizeNotes(input.notes);

  const { account, patientId } = await requireActivePatientAccount(user);
  let doctor;
  try {
    doctor = await User.findById(String(input.doctorId)).select('_id role isActive').lean();
  } catch (_) {
    throw consentError('Unable to verify selected doctor', 500);
  }
  if (!doctor) throw consentError('Doctor not found', 404);
  if (doctor.role !== 'doctor' || doctor.isActive !== true) {
    throw consentError('Consent can only be granted to an active doctor', 400);
  }

  let existing = await findActiveConsent(patientId, doctor._id, scope);
  if (existing) {
    await ensureConsentAudit(account._id, GRANT_ACTION, existing._id);
    await ensureConsentNotification(existing, 'granted');
    return serializeConsent(existing, true);
  }

  let consent;
  try {
    consent = await Consent.create({
      patient: patientId,
      doctor: doctor._id,
      grantedBy: account._id,
      scope,
      ...(notes ? { notes } : {})
    });
  } catch (error) {
    if (error.code === 11000) {
      existing = await findActiveConsent(patientId, doctor._id, scope);
      if (existing) {
        await ensureConsentAudit(account._id, GRANT_ACTION, existing._id);
        await ensureConsentNotification(existing, 'granted');
        return serializeConsent(existing, true);
      }
      throw consentError('An active consent already exists for this doctor', 409);
    }
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      throw consentError('Consent data is invalid', 400);
    }
    throw consentError('Unable to grant consent', 500);
  }

  await ensureConsentAudit(account._id, GRANT_ACTION, consent._id);
  await ensureConsentNotification(consent, 'granted');
  return serializeConsent(consent);
}

async function listPatientConsents(user) {
  const { patientId } = await requireActivePatientAccount(user);
  let consents;
  try {
    consents = await Consent.find({ patient: patientId })
      .select('_id patient doctor scope status grantedAt revokedAt createdAt updatedAt')
      .sort({ createdAt: -1, _id: -1 })
      .lean();
  } catch (_) {
    throw consentError('Unable to retrieve consent records', 500);
  }
  return consents.map((consent) => serializeConsent(consent));
}

async function revokePatientConsent(consentId, user) {
  if (!validObjectId(consentId)) throw consentError('A valid consent ID is required');
  const { account, patientId } = await requireActivePatientAccount(user);

  let consent;
  try {
    consent = await Consent.findById(String(consentId)).lean();
  } catch (_) {
    throw consentError('Unable to retrieve consent record', 500);
  }
  if (!consent || String(consent.patient) !== String(patientId) ||
      String(consent.grantedBy) !== String(account._id)) {
    throw consentError('Consent record not found', 404);
  }

  if (consent.status === 'revoked') {
    await ensureConsentAudit(account._id, REVOKE_ACTION, consent._id);
    await ensureConsentNotification(consent, 'revoked');
    return serializeConsent(consent, true);
  }
  if (consent.status !== 'granted') {
    throw consentError('Consent is not eligible for revocation', 409);
  }

  let revoked;
  try {
    revoked = await Consent.findOneAndUpdate(
      {
        _id: consent._id,
        patient: patientId,
        grantedBy: account._id,
        status: 'granted'
      },
      { $set: { status: 'revoked' } },
      { new: true, runValidators: true }
    ).lean();
  } catch (error) {
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      throw consentError('Consent revocation data is invalid', 400);
    }
    throw consentError('Unable to revoke consent', 500);
  }

  if (!revoked) {
    try {
      revoked = await Consent.findById(String(consentId)).lean();
    } catch (_) {
      throw consentError('Consent revocation may have succeeded, but its status could not be verified', 503, {
        partialSuccess: true,
        consentId: String(consentId)
      });
    }
    if (!revoked || String(revoked.patient) !== String(patientId) ||
        String(revoked.grantedBy) !== String(account._id)) {
      throw consentError('Consent record not found', 404);
    }
    if (revoked.status !== 'revoked') {
      throw consentError('Consent changed before revocation; retry the request', 409);
    }
  }

  await ensureConsentAudit(account._id, REVOKE_ACTION, revoked._id);
  await ensureConsentNotification(revoked, 'revoked');
  return serializeConsent(revoked);
}

module.exports = {
  grantPatientConsent,
  revokePatientConsent,
  listPatientConsents
};
