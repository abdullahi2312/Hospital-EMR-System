const mongoose = require('mongoose');
const { createBreakGlassAuthorization } = require('../services/break-glass.service');

const ALLOWED_BODY_FIELDS = new Set(['reason']);

function badRequest(res, message) {
  return res.status(400).json({ success: false, message, data: null });
}

async function activate(req, res, next) {
  if (Object.keys(req.query || {}).length > 0) {
    return badRequest(res, 'Query parameters are not supported');
  }

  if (!mongoose.isObjectIdOrHexString(req.params.patientId)) {
    return badRequest(res, 'A valid patient ID is required');
  }

  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest(res, 'Request body must be an object');
  }

  if (Object.keys(body).some((field) => !ALLOWED_BODY_FIELDS.has(field))) {
    return badRequest(res, 'Only an emergency reason may be provided');
  }

  if (typeof body.reason !== 'string' || body.reason.trim().length < 20 || body.reason.trim().length > 2000) {
    return badRequest(res, 'Emergency reason must be between 20 and 2000 characters after trimming');
  }

  try {
    const authorization = await createBreakGlassAuthorization(
      req.user,
      req.params.patientId,
      body.reason
    );

    return res.status(201).json({
      success: true,
      message: 'Emergency break-glass access activated; administrator notification status is included',
      data: authorization
    });
  } catch (error) {
    if (error.breakGlassMayRemainWithoutNotifications === true || error.breakGlassMayRemainWithoutAudit === true) {
      return res.status(503).json({
        success: false,
        message: error.breakGlassMayRemainWithoutAudit === true && error.breakGlassMayRemainWithoutNotifications === true
          ? 'Break-glass access may have succeeded, but administrator notifications and audit logging may be incomplete. Check the authorization status before retrying.'
          : error.breakGlassMayRemainWithoutAudit === true
            ? 'Break-glass access and notifications may have succeeded, but audit logging may be incomplete. Check the authorization status before retrying.'
          : 'Break-glass access may have been activated, but administrator notifications may be incomplete. Check the authorization status before retrying.',
        data: {
          partialSuccess: true,
          authorizationId: mongoose.isObjectIdOrHexString(error.breakGlassId)
            ? String(error.breakGlassId)
            : undefined
        }
      });
    }

    return next(error);
  }
}

module.exports = { activate };
