const mongoose = require('mongoose');
const {
  createReferral,
  listReferrals,
  getReferralDetails,
  updateReferralStatus
} = require('../services/referral.service');

const CREATE_FIELDS = new Set([
  'encounterId',
  'receivingHospital',
  'specialist',
  'reason',
  'clinicalSummary',
  'idempotencyKey'
]);
const LIST_QUERY_FIELDS = new Set(['encounterId', 'page', 'limit']);
const STATUS_FIELDS = new Set(['status', 'idempotencyKey']);

function badRequest(res, message) {
  return res.status(400).json({ success: false, message, data: null });
}

function validateObject(body, allowedFields, label) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return `${label} must be an object`;
  }
  if (Object.keys(body).some((field) => !allowedFields.has(field))) {
    return `${label} contains unsupported or server-managed fields`;
  }
  return null;
}

function sendError(error, res, next) {
  if (error.name !== 'ReferralServiceError') {
    const safeError = new Error('Referral request could not be completed');
    safeError.status = 500;
    return next(safeError);
  }

  const status = Number(error.status || error.statusCode) || 500;
  if (error.partialSuccess === true) {
    return res.status(status).json({
      success: false,
      message: 'The referral operation may already have succeeded, but audit logging did not complete. Check the existing referral before retrying. Use the same idempotency key for a retry.',
      data: {
        partialSuccess: true,
        ...(error.referralId ? { referralId: error.referralId } : {})
      }
    });
  }

  return res.status(status).json({
    success: false,
    message: status >= 500 ? 'Unable to process referral request' : error.message,
    data: null
  });
}

async function create(req, res, next) {
  const bodyError = validateObject(req.body, CREATE_FIELDS, 'Request body');
  if (bodyError) return badRequest(res, bodyError);
  if (!mongoose.isObjectIdOrHexString(req.body.encounterId)) {
    return badRequest(res, 'A valid encounter ID is required');
  }
  if (typeof req.body.idempotencyKey !== 'string' || req.body.idempotencyKey.trim().length < 8) {
    return badRequest(res, 'An idempotencyKey of at least 8 characters is required');
  }

  try {
    const referral = await createReferral(req.body, req.user);
    return res.status(referral.replayed ? 200 : 201).json({
      success: true,
      message: referral.replayed ? 'Previously created referral returned' : 'Referral created successfully',
      data: referral
    });
  } catch (error) {
    return sendError(error, res, next);
  }
}

async function list(req, res, next) {
  const query = req.query || {};
  if (Object.keys(query).some((field) => !LIST_QUERY_FIELDS.has(field))) {
    return badRequest(res, 'Query contains unsupported parameters');
  }
  if (query.encounterId !== undefined && !mongoose.isObjectIdOrHexString(query.encounterId)) {
    return badRequest(res, 'A valid encounter ID is required');
  }

  try {
    const result = await listReferrals({
      ...(query.encounterId !== undefined ? { encounterId: query.encounterId } : {}),
      ...(query.page !== undefined ? { page: query.page } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {})
    }, req.user);
    return res.status(200).json({
      success: true,
      message: 'Referrals retrieved successfully',
      data: result
    });
  } catch (error) {
    return sendError(error, res, next);
  }
}

async function details(req, res, next) {
  if (!mongoose.isObjectIdOrHexString(req.params.id)) {
    return badRequest(res, 'A valid referral ID is required');
  }

  try {
    const referral = await getReferralDetails(req.params.id, req.user);
    return res.status(200).json({
      success: true,
      message: 'Referral retrieved successfully',
      data: referral
    });
  } catch (error) {
    return sendError(error, res, next);
  }
}

async function updateStatus(req, res, next) {
  if (!mongoose.isObjectIdOrHexString(req.params.id)) {
    return badRequest(res, 'A valid referral ID is required');
  }
  const bodyError = validateObject(req.body, STATUS_FIELDS, 'Request body');
  if (bodyError) return badRequest(res, bodyError);
  if (typeof req.body.idempotencyKey !== 'string' || req.body.idempotencyKey.trim().length < 8) {
    return badRequest(res, 'An idempotencyKey of at least 8 characters is required');
  }

  try {
    const referral = await updateReferralStatus({
      referralId: req.params.id,
      status: req.body.status,
      idempotencyKey: req.body.idempotencyKey
    }, req.user);
    return res.status(200).json({
      success: true,
      message: referral.replayed ? 'Previously applied referral status returned' : 'Referral status updated successfully',
      data: referral
    });
  } catch (error) {
    return sendError(error, res, next);
  }
}

module.exports = { create, list, details, updateStatus };
