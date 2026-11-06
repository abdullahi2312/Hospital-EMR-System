const mongoose = require('mongoose');
const User = require('../models/User');
const Patient = require('../models/Patient');
const BreakGlass = require('../models/BreakGlass');
const Notification = require('../models/Notification');
const { writeAuditLog } = require('./audit-log.service');
const smsAdapter = require('../adapters/sms.adapter');

const HOURS_24_IN_MS = 24 * 60 * 60 * 1000;

function createServiceError(message, status, properties = {}) {
  const error = new Error(message);
  error.name = 'BreakGlassServiceError';
  error.status = status;
  error.statusCode = status;
  Object.assign(error, properties);
  return error;
}

function validateReason(reason) {
  if (typeof reason !== 'string') {
    throw createServiceError('A valid emergency reason is required', 400);
  }

  const trimmedReason = reason.trim();
  if (trimmedReason.length < 20 || trimmedReason.length > 2000) {
    throw createServiceError(
      'Emergency reason must be between 20 and 2000 characters after trimming',
      400
    );
  }

  return trimmedReason;
}

function toSafeAuthorization(authorization) {
  return {
    id: authorization._id.toString(),
    patient: authorization.patient.toString(),
    doctor: authorization.doctor.toString(),
    reason: authorization.reason,
    status: authorization.status,
    activatedAt: authorization.activatedAt,
    expiresAt: authorization.expiresAt
  };
}

function isTransactionUnsupported(error) {
  const message = String(error?.message || '');
  return error?.code === 20 ||
    /transaction numbers are only allowed|transactions? (?:are|is) not supported|does not support transactions/i.test(message);
}

function buildAdminNotifications(authorization, admins) {
  const authorizationId = authorization._id.toString();
  const patientId = authorization.patient.toString();
  const doctorId = authorization.doctor.toString();
  const activatedAt = authorization.activatedAt.toISOString();
  const expiresAt = authorization.expiresAt.toISOString();
  const message = [
    'Emergency break-glass access was activated.',
    `Authorization: ${authorizationId}`,
    `Patient: ${patientId}`,
    `Doctor: ${doctorId}`,
    `Activated: ${activatedAt}`,
    `Expires: ${expiresAt}`
  ].join(' ');

  return admins.map((admin) => ({
    recipient: admin._id,
    patient: authorization.patient,
    type: 'break_glass_alert',
    title: 'Emergency break-glass access activated',
    message,
    relatedModel: 'BreakGlass',
    relatedId: authorization._id
  }));
}

async function createAdminNotifications(authorization, session) {
  const admins = await User.find({ role: 'admin', isActive: true })
    .select('_id phone')
    .session(session || null)
    .lean();

  if (admins.length === 0) {
    return { status: 'no_active_admins', count: 0, smsRecipients: [] };
  }

  const notifications = buildAdminNotifications(authorization, admins);
  const options = { ordered: true };
  if (session) {
    options.session = session;
  }

  const createdNotifications = await Notification.insertMany(notifications, options);
  return {
    status: 'sent',
    count: createdNotifications.length,
    smsRecipients: admins.map(({ _id, phone }) => ({ id: _id, phone }))
  };
}

async function deliverSimulatedAdminSms(authorization, recipients = []) {
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  const message = 'Emergency access alert: please review the authorization in the hospital EMR admin panel.';
  for (const recipient of recipients) {
    if (typeof recipient.phone !== 'string' || !/^\+[1-9]\d{7,14}$/.test(recipient.phone.trim())) {
      skipped += 1;
      continue;
    }
    attempted += 1;
    try {
      const result = await smsAdapter.sendSms({
        phoneNumber: recipient.phone,
        message,
        idempotencyKey: `breakglass-${authorization._id}-${recipient.id}`
      });
      if (result.simulated === true && result.deliveryStatus === 'simulated_success') succeeded += 1;
      else failed += 1;
    } catch (_) {
      failed += 1;
    }
  }
  return {
    simulated: true,
    status: failed > 0 ? 'simulated_partial_failure' : attempted > 0 ? 'simulated_success' : 'not_attempted',
    attempted,
    succeeded,
    failed,
    skipped
  };
}

function createAuthorizationDocument({ patientId, doctorId, reason }) {
  const activatedAt = new Date();
  const expiresAt = new Date(activatedAt.getTime() + HOURS_24_IN_MS);

  return new BreakGlass({
    patient: patientId,
    doctor: doctorId,
    reason,
    status: 'active',
    activatedAt,
    expiresAt
  });
}

async function auditActivation(authorization, doctorId) {
  try {
    await writeAuditLog({
      actorId: doctorId,
      action: 'break_glass_activated',
      entityType: 'BreakGlass',
      entityId: authorization._id
    });
  } catch (_) {
    throw createServiceError(
      'Break-glass authorization may have been activated, but audit logging failed. Check the authorization status before retrying.',
      503,
      {
        breakGlassMayRemainWithoutAudit: true,
        breakGlassId: authorization._id.toString()
      }
    );
  }
}

async function createWorkflowTransaction(input) {
  const session = await mongoose.startSession();
  let authorization;
  let notificationResult;

  try {
    await session.withTransaction(async () => {
      authorization = createAuthorizationDocument(input);
      await authorization.save({ session });
      notificationResult = await createAdminNotifications(authorization, session);
    });

    return { authorization, notificationResult };
  } finally {
    await session.endSession();
  }
}

async function createWorkflowWithoutTransaction(input) {
  const authorization = createAuthorizationDocument(input);

  try {
    await authorization.save();
  } catch (error) {
    if (error.name === 'ValidationError') {
      throw createServiceError('Break-glass authorization data is invalid', 400);
    }
    throw createServiceError('Unable to create break-glass authorization', 500);
  }

  let notificationResult;
  try {
    notificationResult = await createAdminNotifications(authorization);
  } catch (_) {
    let auditIncomplete = false;
    try {
      await auditActivation(authorization, authorization.doctor);
    } catch (_) {
      auditIncomplete = true;
    }
    throw createServiceError(
      auditIncomplete
        ? 'Break-glass authorization was created, but administrator notifications and audit logging may be incomplete.'
        : 'Break-glass authorization was created and audited, but administrator notifications may be incomplete.',
      500,
      {
        breakGlassMayRemainWithoutNotifications: true,
        ...(auditIncomplete ? { breakGlassMayRemainWithoutAudit: true } : {}),
        breakGlassId: authorization._id.toString()
      }
    );
  }

  return { authorization, notificationResult };
}

async function createBreakGlassAuthorization(user, patientId, reason) {
  if (!user || typeof user !== 'object' || !mongoose.isObjectIdOrHexString(user.id)) {
    throw createServiceError('Authentication required', 401);
  }

  if (!mongoose.isObjectIdOrHexString(patientId)) {
    throw createServiceError('A valid patient ID is required', 400);
  }

  const trimmedReason = validateReason(reason);
  const doctorId = String(user.id);
  const normalizedPatientId = String(patientId);

  let doctor;
  try {
    doctor = await User.findById(doctorId)
      .select('_id role isActive')
      .lean();
  } catch (_) {
    throw createServiceError('Unable to verify authorization to create break-glass access', 500);
  }

  if (!doctor) {
    throw createServiceError('Authentication required', 401);
  }

  if (doctor.role !== 'doctor' || doctor.isActive !== true) {
    throw createServiceError('Only active doctors may create break-glass authorizations', 403);
  }

  let patientExists;
  try {
    patientExists = await Patient.exists({ _id: normalizedPatientId });
  } catch (_) {
    throw createServiceError('Unable to verify the requested patient', 500);
  }

  if (!patientExists) {
    throw createServiceError('Patient not found', 404);
  }

  const workflowInput = {
    patientId: normalizedPatientId,
    doctorId: doctor._id,
    reason: trimmedReason
  };
  let workflow;
  try {
    workflow = await createWorkflowTransaction(workflowInput);
  } catch (error) {
    if (isTransactionUnsupported(error)) {
      workflow = await createWorkflowWithoutTransaction(workflowInput);
    } else if (error.name === 'ValidationError') {
      throw createServiceError('Break-glass authorization data is invalid', 400);
    } else {
      throw createServiceError(
        'Break-glass workflow could not be completed or confirmed; verify its status before retrying',
        500
      );
    }
  }

  await auditActivation(workflow.authorization, doctor._id);
  const smsDelivery = await deliverSimulatedAdminSms(
    workflow.authorization,
    workflow.notificationResult.smsRecipients
  );

  return {
    ...toSafeAuthorization(workflow.authorization),
    notificationStatus: workflow.notificationResult.status,
    notificationCount: workflow.notificationResult.count,
    smsDelivery
  };
}

module.exports = {
  createBreakGlassAuthorization
};
