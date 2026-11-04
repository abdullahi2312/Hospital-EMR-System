const mongoose = require('mongoose');
const Patient = require('../models/Patient');
const Encounter = require('../models/Encounter');
const Consent = require('../models/Consent');
const BreakGlass = require('../models/BreakGlass');
const AccessLog = require('../models/AccessLog');

const DENIED_MESSAGE = 'Access to this patient record is not permitted';

function decision(allowed, statusCode, message) {
  return { allowed, statusCode, message };
}

function normalizeAccessReason(accessReason) {
  if (typeof accessReason !== 'string') {
    return undefined;
  }

  const normalized = accessReason.trim().slice(0, 1000);
  return normalized || undefined;
}

async function recordDecision({
  patientId,
  userId,
  encounterId,
  consentId,
  breakGlassId,
  accessReason,
  allowed,
  accessMethod
}) {
  const log = {
    patient: patientId,
    user: userId,
    action: allowed ? 'view_record' : 'denied_access',
    accessMethod
  };

  if (encounterId) {
    log.encounter = encounterId;
  }
  if (consentId) {
    log.consent = consentId;
  }
  if (breakGlassId) {
    log.breakGlass = breakGlassId;
  }
  if (accessReason) {
    log.accessReason = accessReason;
  }

  try {
    await AccessLog.create(log);
  } catch (_) {
    const error = new Error('Unable to record patient access decision');
    error.name = 'PatientAccessAuditError';
    error.status = 500;
    throw error;
  }
}

async function authorizePatientRecordAccess(user, patientId, encounterId, accessReason) {
  if (!user || typeof user !== 'object' || !mongoose.isObjectIdOrHexString(user.id)) {
    return decision(false, 401, 'Authentication required');
  }

  if (!mongoose.isObjectIdOrHexString(patientId)) {
    return decision(false, 400, 'A valid patient ID is required');
  }

  const userId = String(user.id);
  const normalizedPatientId = String(patientId);
  const hasEncounterId = encounterId !== undefined && encounterId !== null;
  const normalizedEncounterId = hasEncounterId ? String(encounterId) : undefined;
  const reason = normalizeAccessReason(accessReason);

  if (hasEncounterId && !mongoose.isObjectIdOrHexString(normalizedEncounterId)) {
    await recordDecision({
      patientId: normalizedPatientId,
      userId,
      accessReason: reason,
      allowed: false,
      accessMethod: 'denied'
    });
    return decision(false, 400, 'A valid encounter ID is required');
  }

  const patientExists = await Patient.exists({ _id: normalizedPatientId });
  if (!patientExists) {
    await recordDecision({
      patientId: normalizedPatientId,
      userId,
      accessReason: reason,
      allowed: false,
      accessMethod: 'denied'
    });
    return decision(false, 403, DENIED_MESSAGE);
  }

  let encounter;
  if (hasEncounterId) {
    encounter = await Encounter.findById(normalizedEncounterId)
      .select('_id patient assignedDoctor')
      .lean();
  }

  const auditEncounterId = encounter ? encounter._id.toString() : undefined;
  let allowed = false;
  let accessMethod = 'denied';
  let consentId;
  let breakGlassId;

  if (user.role === 'patient') {
    const linkedPatientId = mongoose.isObjectIdOrHexString(user.patient)
      ? String(user.patient)
      : undefined;

    allowed = linkedPatientId === normalizedPatientId &&
      (!hasEncounterId || Boolean(
        encounter && String(encounter.patient) === normalizedPatientId
      ));

    if (allowed) {
      accessMethod = 'patient_portal';
    }
  } else if (user.role === 'doctor') {
    const encounterMatchesPatient = !hasEncounterId || Boolean(
      encounter && String(encounter.patient) === normalizedPatientId
    );

    // A supplied encounter must belong to this patient; later fallback paths
    // cannot override an invalid encounter/patient relationship.
    if (encounterMatchesPatient) {
      if (hasEncounterId && String(encounter.assignedDoctor) === userId) {
        allowed = true;
        accessMethod = 'assigned_visit';
      }

      if (!allowed && hasEncounterId) {
        const consent = await Consent.findOne({
          patient: normalizedPatientId,
          doctor: userId,
          status: 'granted',
          scope: 'clinical_record'
        })
          .select('_id')
          .lean();

        if (consent) {
          allowed = true;
          accessMethod = 'patient_consent';
          consentId = consent._id.toString();
        }
      }

      if (!allowed) {
        const lookupTime = new Date();
        const breakGlassRecords = await BreakGlass.find({
          patient: normalizedPatientId,
          doctor: userId,
          status: 'active',
          reviewedBy: null,
          reviewedAt: null,
          expiresAt: { $gt: lookupTime }
        })
          .select('_id')
          .lean();

        for (const candidate of breakGlassRecords) {
          const currentRecord = await BreakGlass.findOne({
            _id: candidate._id,
            patient: normalizedPatientId,
            doctor: userId,
            status: 'active',
            reviewedBy: null,
            reviewedAt: null,
            expiresAt: { $gt: new Date() }
          })
            .select('_id patient doctor status reason expiresAt reviewedBy reviewedAt')
            .lean();

          const finalDecisionTime = new Date();
          if (
            currentRecord &&
            String(currentRecord.patient) === normalizedPatientId &&
            String(currentRecord.doctor) === userId &&
            currentRecord.status === 'active' &&
            currentRecord.reviewedBy == null &&
            currentRecord.reviewedAt == null &&
            typeof currentRecord.reason === 'string' &&
            currentRecord.reason.trim().length >= 20 &&
            currentRecord.expiresAt instanceof Date &&
            currentRecord.expiresAt.getTime() > finalDecisionTime.getTime()
          ) {
            allowed = true;
            accessMethod = 'break_glass';
            breakGlassId = currentRecord._id.toString();
            break;
          }
        }
      }
    }
  }

  await recordDecision({
    patientId: normalizedPatientId,
    userId,
    encounterId: auditEncounterId,
    consentId,
    breakGlassId,
    accessReason: reason,
    allowed,
    accessMethod
  });

  return allowed
    ? decision(true, 200, 'Patient record access authorized')
    : decision(false, 403, DENIED_MESSAGE);
}

module.exports = {
  authorizePatientRecordAccess
};
