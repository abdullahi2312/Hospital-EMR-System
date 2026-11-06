const mongoose = require('mongoose');
const {
  grantPatientConsent,
  revokePatientConsent,
  listPatientConsents
} = require('../services/consent.service');

const GRANT_FIELDS = new Set(['doctorId', 'scope', 'notes']);

function badRequest(res, message) {
  return res.status(400).json({ success: false, message, data: null });
}

function validateObjectBody(body, allowedFields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be an object';
  }
  if (Object.keys(body).some((field) => !allowedFields.has(field))) {
    return 'Request contains unsupported or server-managed fields';
  }
  return null;
}

function handleError(error, res, next) {
  if (error.name !== 'ConsentServiceError') return next(error);
  if (error.partialSuccess !== true) return next(error);

  return res.status(Number(error.status) || 503).json({
    success: false,
    message: error.notificationFailure === true
      ? 'The consent change succeeded, but its notification may be incomplete. Check the consent record and retry the same operation to recover the notice.'
      : 'The consent change may already have succeeded, but audit logging did not complete. Check the consent record before retrying; retry the same operation only to recover audit logging.',
    data: {
      partialSuccess: true,
      ...(error.consentId ? { consentId: error.consentId } : {})
    }
  });
}

async function grant(req, res, next) {
  const bodyError = validateObjectBody(req.body, GRANT_FIELDS);
  if (bodyError) return badRequest(res, bodyError);

  try {
    const consent = await grantPatientConsent(req.body, req.user);
    return res.status(consent.replayed ? 200 : 201).json({
      success: true,
      message: consent.replayed ? 'Existing active consent returned' : 'Consent granted successfully',
      data: consent
    });
  } catch (error) {
    return handleError(error, res, next);
  }
}

async function list(req, res, next) {
  if (Object.keys(req.query || {}).length > 0) {
    return badRequest(res, 'Consent list does not accept query parameters');
  }

  try {
    const consents = await listPatientConsents(req.user);
    return res.status(200).json({
      success: true,
      message: 'Your consent records retrieved successfully',
      data: { consents }
    });
  } catch (error) {
    return handleError(error, res, next);
  }
}

async function revoke(req, res, next) {
  if (!mongoose.isObjectIdOrHexString(req.params.consentId)) {
    return badRequest(res, 'A valid consent ID is required');
  }

  try {
    const consent = await revokePatientConsent(req.params.consentId, req.user);
    return res.status(200).json({
      success: true,
      message: consent.replayed ? 'Consent was already revoked' : 'Consent revoked successfully',
      data: consent
    });
  } catch (error) {
    return handleError(error, res, next);
  }
}

module.exports = { grant, list, revoke };
