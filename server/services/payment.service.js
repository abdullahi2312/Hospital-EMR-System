'use strict';

const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const Patient = require('../models/Patient');
const User = require('../models/User');
const { initiatePayment: simulatePayment } = require('../adapters/mobile-money.adapter');
const { writeAuditLog } = require('./audit-log.service');

const INPUT_FIELDS = new Set(['phoneNumber', 'amount', 'currency', 'description', 'idempotencyKey']);
const LIST_FIELDS = new Set(['page', 'limit']);
const PAYMENT_OUTCOMES = {
  simulated_success: 'simulated_success',
  simulated_pending: 'pending',
  simulated_failure: 'simulated_failed'
};
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_SKIP = 100_000;

function paymentError(message, status = 400, properties = {}) {
  const error = new Error(message);
  error.name = 'PaymentServiceError';
  error.status = status;
  error.statusCode = status;
  Object.assign(error, properties);
  return error;
}

function rejectUnknownFields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw paymentError(`${label} must be an object`, 400);
  }
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    throw paymentError(`${label} contains unsupported or server-managed fields`, 400);
  }
}

function normalizePaymentInput(input) {
  rejectUnknownFields(input, INPUT_FIELDS, 'Payment input');

  if (typeof input.phoneNumber !== 'string' || !/^\+[1-9]\d{7,14}$/.test(input.phoneNumber.trim())) {
    throw paymentError('Phone number must use international E.164 format', 400);
  }
  if (typeof input.idempotencyKey !== 'string') {
    throw paymentError('An idempotency key is required', 400);
  }
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw paymentError('Idempotency key must contain between 8 and 128 characters', 400);
  }
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount <= 0 || input.amount > 1_000_000 ||
      Math.abs(input.amount * 100 - Math.round(input.amount * 100)) > 1e-7) {
    throw paymentError('Amount must be positive, finite, within the supported limit, and have at most two decimal places', 400);
  }
  if (typeof input.currency !== 'string' || !['USD', 'SOS'].includes(input.currency.trim().toUpperCase())) {
    throw paymentError('Currency must be USD or SOS', 400);
  }

  let description;
  if (input.description !== undefined) {
    if (typeof input.description !== 'string' || input.description.trim().length > 140) {
      throw paymentError('Description must be text of at most 140 characters', 400);
    }
    description = input.description.trim() || undefined;
  }

  return {
    phoneNumber: input.phoneNumber.trim(),
    amount: input.amount,
    currency: input.currency.trim().toUpperCase(),
    ...(description ? { description } : {}),
    idempotencyKey
  };
}

function parsePositiveInteger(value, field, defaultValue, maximum) {
  if (value === undefined) return defaultValue;
  const normalized = typeof value === 'number' ? String(value) : value;
  if (typeof normalized !== 'string' || !/^\d+$/.test(normalized)) {
    throw paymentError(`${field} must be a positive whole number`, 400);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw paymentError(`${field} must be between 1 and ${maximum}`, 400);
  }
  return parsed;
}

function isObjectId(value) {
  return mongoose.isObjectIdOrHexString(value);
}

async function requireActivePatient(user) {
  if (!user || typeof user !== 'object' || !isObjectId(user.id)) {
    throw paymentError('Authentication required', 401);
  }

  let account;
  try {
    account = await User.findById(String(user.id))
      .select('_id role patient isActive')
      .lean();
  } catch (_) {
    throw paymentError('Unable to verify authenticated user', 500);
  }
  if (!account || account.isActive !== true) {
    throw paymentError('Authentication required', 401);
  }
  if (account.role !== 'patient') {
    throw paymentError('Only patient portal users may manage patient payments', 403);
  }
  if (!isObjectId(account.patient)) {
    throw paymentError('Patient account is not linked to a valid patient record', 403);
  }

  let patientExists;
  try {
    patientExists = await Patient.exists({ _id: account.patient });
  } catch (_) {
    throw paymentError('Unable to verify linked patient record', 500);
  }
  if (!patientExists) {
    throw paymentError('Patient account is not linked to an existing patient record', 403);
  }
  return account;
}

function fingerprintInput(input, patientId) {
  try {
    return Payment.createInputFingerprint({
      phoneNumber: input.phoneNumber,
      amount: input.amount,
      currency: input.currency,
      ...(input.description !== undefined ? { description: input.description } : {}),
      patientId: String(patientId)
    });
  } catch (error) {
    if (error.name === 'PaymentFingerprintConfigurationError') {
      throw paymentError('Payment fingerprinting is not configured', 503);
    }
    throw paymentError(error.message || 'Payment input is invalid', 400);
  }
}

function fingerprintsMatch(first, second) {
  if (typeof first !== 'string' || typeof second !== 'string' ||
      !/^[a-f0-9]{64}$/.test(first) || !/^[a-f0-9]{64}$/.test(second)) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(first, 'hex'), Buffer.from(second, 'hex'));
}

const PAYMENT_SELECT = [
  '_id paymentReference patient initiatingUser amount currency status provider description createdAt updatedAt',
  '+idempotencyKey +inputFingerprint'
].join(' ');

async function findByUserAndIdempotency(userId, idempotencyKey) {
  try {
    return await Payment.findOne({ initiatingUser: userId, idempotencyKey })
      .select(PAYMENT_SELECT)
      .lean();
  } catch (_) {
    throw paymentError('Unable to retrieve payment record', 500);
  }
}

function verifyExistingInput(payment, fingerprint, patientId) {
  if (String(payment.patient) !== String(patientId) || !fingerprintsMatch(payment.inputFingerprint, fingerprint)) {
    throw paymentError('Idempotency key was already used for different payment input', 409);
  }
}

function toSafePayment(payment) {
  return {
    id: String(payment._id),
    paymentReference: payment.paymentReference,
    patient: String(payment.patient),
    amount: payment.amount,
    currency: payment.currency,
    status: payment.status,
    provider: payment.provider,
    simulated: true,
    message: 'This is a payment simulation; no real money was transferred.',
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt
  };
}

function auditDeduplicationKey(paymentId, eventType) {
  return crypto.createHash('sha256')
    .update(`hospital-emr:payment:${String(paymentId)}:${eventType}`)
    .digest('hex');
}

async function writePaymentAudit(payment, action) {
  try {
    await writeAuditLog({
      actorId: payment.initiatingUser,
      action,
      entityType: 'Payment',
      entityId: payment._id,
      paymentDeduplicationKey: auditDeduplicationKey(payment._id, action)
    });
  } catch (_) {
    throw paymentError(
      'Payment may already exist, but audit logging did not complete. Check payment status before retrying with the same idempotency key.',
      503,
      { partialSuccess: true, paymentReference: payment.paymentReference }
    );
  }
}

async function recoverPaymentByReference(payment, account) {
  try {
    return await Payment.findOne({
      _id: payment._id,
      initiatingUser: account._id,
      patient: account.patient
    }).select(PAYMENT_SELECT).lean();
  } catch (_) {
    throw paymentError(
      'Payment outcome could not be confirmed. Check payment status before retrying with the same idempotency key.',
      503,
      { partialSuccess: true, paymentReference: payment.paymentReference }
    );
  }
}

async function applyAdapterOutcome(payment, input, account) {
  let outcome;
  try {
    outcome = await simulatePayment({
      phoneNumber: input.phoneNumber,
      amount: input.amount,
      currency: input.currency,
      ...(input.description ? { description: input.description } : {}),
      idempotencyKey: input.idempotencyKey
    });
  } catch (_) {
    throw paymentError(
      'Payment request is recorded but its simulated provider outcome is not confirmed. Check payment status before retrying with the same idempotency key.',
      503,
      { partialSuccess: true, paymentReference: payment.paymentReference }
    );
  }

  const targetStatus = outcome?.simulated === true ? PAYMENT_OUTCOMES[outcome.status] : undefined;
  if (!targetStatus) {
    throw paymentError(
      'Payment request is recorded but its simulated provider outcome is invalid. Check payment status before retrying with the same idempotency key.',
      503,
      { partialSuccess: true, paymentReference: payment.paymentReference }
    );
  }

  if (targetStatus === 'pending' || payment.status !== 'pending') {
    return payment;
  }

  let transitioned;
  try {
    transitioned = await Payment.transitionStatus(payment.paymentReference, targetStatus);
  } catch (_) {
    throw paymentError(
      'Payment request is recorded but its status update could not be confirmed. Check payment status before retrying with the same idempotency key.',
      503,
      { partialSuccess: true, paymentReference: payment.paymentReference }
    );
  }
  if (transitioned) return transitioned;

  const latest = await recoverPaymentByReference(payment, account);
  if (latest?.status === targetStatus || latest?.status === 'pending' || latest?.status === 'simulated_success' || latest?.status === 'simulated_failed') {
    return latest;
  }
  throw paymentError(
    'Payment status changed concurrently and could not be confirmed. Check payment status before retrying with the same idempotency key.',
    503,
    { partialSuccess: true, paymentReference: payment.paymentReference }
  );
}

async function ensurePaymentAudits(payment) {
  await writePaymentAudit(payment, 'payment_initiated');
  if (payment.status === 'simulated_success' || payment.status === 'simulated_failed') {
    await writePaymentAudit(payment, 'payment_status_changed');
  }
}

async function initiatePatientPayment(input, user) {
  const account = await requireActivePatient(user);
  const normalized = normalizePaymentInput(input);
  const fingerprint = fingerprintInput(normalized, account.patient);

  let existing = await findByUserAndIdempotency(account._id, normalized.idempotencyKey);
  if (existing) {
    verifyExistingInput(existing, fingerprint, account.patient);
    if (existing.status === 'pending') {
      existing = await applyAdapterOutcome(existing, normalized, account);
    }
    await ensurePaymentAudits(existing);
    return toSafePayment(existing);
  }

  let payment = new Payment({
    patient: account.patient,
    initiatingUser: account._id,
    amount: normalized.amount,
    currency: normalized.currency,
    idempotencyKey: normalized.idempotencyKey,
    inputFingerprint: fingerprint,
    ...(normalized.description ? { description: normalized.description } : {})
  });

  try {
    await payment.save();
  } catch (error) {
    if (error.code === 11000) {
      existing = await findByUserAndIdempotency(account._id, normalized.idempotencyKey);
      if (!existing) {
        throw paymentError('Payment creation conflicted and could not be safely confirmed', 503);
      }
      verifyExistingInput(existing, fingerprint, account.patient);
      payment = existing;
    } else if (error.name === 'ValidationError' || error.name === 'CastError' || error.name === 'StrictModeError') {
      throw paymentError('Payment input is invalid', 400);
    } else {
      throw paymentError('Unable to record payment request', 500);
    }
  }

  if (payment.status === 'pending') {
    payment = await applyAdapterOutcome(payment, normalized, account);
  }
  await ensurePaymentAudits(payment);
  return toSafePayment(payment);
}

function validPaymentReference(reference) {
  return typeof reference === 'string' &&
    /^pay-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(reference.trim());
}

async function getPatientPaymentStatus(paymentReference, user) {
  const account = await requireActivePatient(user);
  if (!validPaymentReference(paymentReference)) {
    throw paymentError('A valid payment reference is required', 400);
  }

  let payment;
  try {
    payment = await Payment.findOne({
      paymentReference: paymentReference.trim(),
      initiatingUser: account._id,
      patient: account.patient
    }).select(PAYMENT_SELECT).lean();
  } catch (_) {
    throw paymentError('Unable to retrieve payment status', 500);
  }
  if (!payment) throw paymentError('Payment not found', 404);
  return toSafePayment(payment);
}

async function listPatientPayments(options = {}, user) {
  const account = await requireActivePatient(user);
  rejectUnknownFields(options, LIST_FIELDS, 'Payment list options');
  const page = parsePositiveInteger(options.page, 'Page', DEFAULT_PAGE, 1_000_000);
  const limit = parsePositiveInteger(options.limit, 'Limit', DEFAULT_LIMIT, MAX_LIMIT);
  const skip = (page - 1) * limit;
  if (skip > MAX_SKIP) throw paymentError(`Requested page exceeds the supported payment history window`, 413);

  let records;
  try {
    records = await Payment.find({ initiatingUser: account._id, patient: account.patient })
      .select(PAYMENT_SELECT)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit + 1)
      .lean();
  } catch (_) {
    throw paymentError('Unable to retrieve payment history', 500);
  }

  return {
    payments: records.slice(0, limit).map(toSafePayment),
    pagination: { page, limit, hasMore: records.length > limit }
  };
}

module.exports = {
  initiatePatientPayment,
  getPatientPaymentStatus,
  listPatientPayments
};
