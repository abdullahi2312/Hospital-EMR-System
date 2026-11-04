const mongoose = require('mongoose');
const {
  createLabOrder,
  listPendingLabOrders,
  getLabOrderDetails,
  recordLabResult,
  rejectLabSample
} = require('../services/lab.service');

const ORDER_FIELDS = new Set(['testName', 'instructions', 'priority', 'idempotencyKey']);
const RESULT_FIELDS = new Set([
  'resultType', 'numericValue', 'textValue', 'unit', 'referenceRange', 'notes', 'idempotencyKey'
]);

function badRequest(res, message) {
  return res.status(400).json({ success: false, message, data: null });
}

function validId(value) {
  return mongoose.isObjectIdOrHexString(value);
}

function validateBody(body, allowedFields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be an object';
  }
  if (Object.keys(body).some((field) => !allowedFields.has(field))) {
    return 'Request contains unsupported or server-managed fields';
  }
  return null;
}

function partialSuccess(res, error, entityFields) {
  if (error.name !== 'LabServiceError' || error.partialSuccess !== true) return false;
  const data = { partialSuccess: true };
  for (const field of entityFields) {
    if (error[field]) data[field] = error[field];
  }
  return res.status(error.status || 503).json({
    success: false,
    message: 'The lab operation may have been saved, but audit logging or completion did not finish. Verify the order or result before retrying.',
    data
  });
}

async function createOrder(req, res, next) {
  const validationError = validateBody(req.body, ORDER_FIELDS);
  if (validationError) return badRequest(res, validationError);
  if (!validId(req.params.encounterId)) return badRequest(res, 'A valid encounter ID is required');

  try {
    const order = await createLabOrder(
      { ...req.body, encounter: req.params.encounterId },
      req.user
    );
    return res.status(order.replayed ? 200 : 201).json({
      success: true,
      message: order.replayed ? 'Previously created lab order returned' : 'Lab order created successfully',
      data: order
    });
  } catch (error) {
    if (partialSuccess(res, error, ['labOrderId'])) return;
    return next(error);
  }
}

async function listPending(req, res, next) {
  const query = req.query || {};
  if (Object.keys(query).some((field) => field !== 'limit')) {
    return badRequest(res, 'Only the limit query parameter is supported');
  }
  let options = {};
  if (query.limit !== undefined) {
    if (Array.isArray(query.limit) || !/^\d+$/.test(String(query.limit))) {
      return badRequest(res, 'Limit must be an integer between 1 and 100');
    }
    options = { limit: Number(query.limit) };
    if (options.limit < 1 || options.limit > 100) {
      return badRequest(res, 'Limit must be an integer between 1 and 100');
    }
  }
  try {
    const orders = await listPendingLabOrders(req.user, options);
    return res.status(200).json({
      success: true,
      message: 'Pending lab orders retrieved successfully',
      data: { orders }
    });
  } catch (error) {
    return next(error);
  }
}

async function getOrder(req, res, next) {
  if (!validId(req.params.orderId)) return badRequest(res, 'A valid lab order ID is required');
  try {
    const order = await getLabOrderDetails(req.params.orderId, req.user);
    return res.status(200).json({
      success: true,
      message: 'Lab order retrieved successfully',
      data: order
    });
  } catch (error) {
    return next(error);
  }
}

async function createResult(req, res, next) {
  const validationError = validateBody(req.body, RESULT_FIELDS);
  if (validationError) return badRequest(res, validationError);
  if (!validId(req.params.orderId)) return badRequest(res, 'A valid lab order ID is required');

  try {
    const result = await recordLabResult(
      { ...req.body, orderId: req.params.orderId },
      req.user
    );
    return res.status(result.replayed ? 200 : 201).json({
      success: true,
      message: result.replayed ? 'Previously recorded lab result returned' : 'Lab result recorded successfully',
      data: result
    });
  } catch (error) {
    if (partialSuccess(res, error, ['labResultId', 'labOrderId'])) return;
    return next(error);
  }
}

async function rejectSample(req, res, next) {
  const validationError = validateBody(req.body, new Set(['reason']));
  if (validationError) return badRequest(res, validationError);
  if (!validId(req.params.orderId)) return badRequest(res, 'A valid lab order ID is required');

  try {
    const order = await rejectLabSample(
      { reason: req.body.reason, orderId: req.params.orderId },
      req.user
    );
    return res.status(200).json({
      success: true,
      message: order.replayed ? 'Previously rejected lab sample returned' : 'Lab sample rejected successfully',
      data: order
    });
  } catch (error) {
    if (partialSuccess(res, error, ['labOrderId'])) return;
    return next(error);
  }
}

module.exports = {
  createOrder,
  listPending,
  getOrder,
  createResult,
  rejectSample
};
