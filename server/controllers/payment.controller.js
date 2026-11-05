'use strict';

const {
  initiatePatientPayment,
  getPatientPaymentStatus,
  listPatientPayments
} = require('../services/payment.service');

const INITIATE_FIELDS = new Set(['phoneNumber', 'amount', 'currency', 'description', 'idempotencyKey']);
const LIST_QUERY_FIELDS = new Set(['page', 'limit']);
const SAFE_PAYMENT_FIELDS = [
  'id', 'paymentReference', 'amount', 'currency', 'status', 'provider', 'createdAt', 'updatedAt'
];
const SIMULATION_NOTICE = 'This is a payment simulation; no real money was transferred.';

function badRequest(res, message) {
  return res.status(400).json({ success: false, message, data: null });
}

function validateObject(value, allowedFields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return `${label} must be an object`;
  }
  if (Object.keys(value).some((field) => !allowedFields.has(field))) {
    return `${label} contains unsupported or server-managed fields`;
  }
  return null;
}

function hasUnsupportedQuery(query, allowedFields = new Set()) {
  return Object.keys(query || {}).some((field) => !allowedFields.has(field));
}

function safePayment(payment) {
  const result = {};
  if (payment && typeof payment === 'object') {
    for (const field of SAFE_PAYMENT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(payment, field)) result[field] = payment[field];
    }
  }
  result.simulated = true;
  result.message = SIMULATION_NOTICE;
  return result;
}

function safePaymentList(data) {
  return {
    payments: Array.isArray(data?.payments) ? data.payments.map(safePayment) : [],
    pagination: {
      page: data?.pagination?.page,
      limit: data?.pagination?.limit,
      hasMore: data?.pagination?.hasMore === true
    }
  };
}

function handleError(error, res, next) {
  if (error.name !== 'PaymentServiceError') return next(error);

  const status = Number(error.status || error.statusCode) || 500;
  if (error.partialSuccess === true) {
    return res.status(status >= 500 ? status : 503).json({
      success: false,
      message: 'The simulated payment may already be recorded, but audit or status confirmation did not complete. Check payment status before retrying with the same idempotency key.',
      data: {
        partialSuccess: true,
        ...(error.paymentReference ? { paymentReference: error.paymentReference } : {})
      }
    });
  }

  return res.status(status).json({
    success: false,
    message: status >= 500 ? 'Unable to process payment request' : error.message,
    data: null
  });
}

async function initiate(req, res, next) {
  if (hasUnsupportedQuery(req.query)) {
    return badRequest(res, 'Query contains unsupported parameters');
  }

  const bodyError = validateObject(req.body, INITIATE_FIELDS, 'Request body');
  if (bodyError) return badRequest(res, bodyError);

  const input = {};
  for (const field of INITIATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) input[field] = req.body[field];
  }

  try {
    const payment = await initiatePatientPayment(input, req.user);
    return res.status(200).json({
      success: true,
      message: 'Simulated payment request processed. No real money was transferred.',
      data: safePayment(payment)
    });
  } catch (error) {
    return handleError(error, res, next);
  }
}

async function list(req, res, next) {
  const query = req.query || {};
  if (hasUnsupportedQuery(query, LIST_QUERY_FIELDS)) {
    return badRequest(res, 'Query contains unsupported parameters');
  }

  const options = {};
  for (const field of LIST_QUERY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(query, field)) options[field] = query[field];
  }

  try {
    const result = await listPatientPayments(options, req.user);
    return res.status(200).json({
      success: true,
      message: 'Your simulated payment history was retrieved successfully.',
      data: safePaymentList(result)
    });
  } catch (error) {
    return handleError(error, res, next);
  }
}

async function getStatus(req, res, next) {
  if (hasUnsupportedQuery(req.query)) {
    return badRequest(res, 'Query contains unsupported parameters');
  }

  try {
    const payment = await getPatientPaymentStatus(req.params.paymentReference, req.user);
    return res.status(200).json({
      success: true,
      message: 'Simulated payment status retrieved successfully. No real money was transferred.',
      data: safePayment(payment)
    });
  } catch (error) {
    return handleError(error, res, next);
  }
}

module.exports = { initiate, list, getStatus };
