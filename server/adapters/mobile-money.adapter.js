'use strict';

const crypto = require('node:crypto');

const SUPPORTED_CURRENCIES = new Set(['USD', 'SOS']);
const MAX_AMOUNT = 1_000_000;
const MAX_DESCRIPTION_LENGTH = 140;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_STORED_PAYMENTS = 5000;
const payments = new Map();
const idempotencyKeys = new Map();
const ALLOWED_FIELDS = new Set([
  'phoneNumber',
  'amount',
  'currency',
  'description',
  'idempotencyKey',
  'simulateOutcome'
]);

function inputError(message) {
  return new TypeError(message);
}

function normalizeInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw inputError('Payment input must be an object');
  }
  if (Object.keys(input).some((field) => !ALLOWED_FIELDS.has(field))) {
    throw inputError('Payment input contains unsupported or server-managed fields');
  }

  if (typeof input.phoneNumber !== 'string' || !/^\+[1-9]\d{7,14}$/.test(input.phoneNumber.trim())) {
    throw inputError('Phone number must use international E.164 format');
  }

  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount <= 0 || input.amount > MAX_AMOUNT) {
    throw inputError(`Amount must be a positive finite number no greater than ${MAX_AMOUNT}`);
  }
  const minorUnits = input.amount * 100;
  if (Math.abs(minorUnits - Math.round(minorUnits)) > 1e-7) {
    throw inputError('Amount cannot have more than two decimal places');
  }

  if (typeof input.currency !== 'string') {
    throw inputError('A supported currency is required');
  }
  const currency = input.currency.trim().toUpperCase();
  if (!SUPPORTED_CURRENCIES.has(currency)) {
    throw inputError('Currency must be one of the supported currencies: USD, SOS');
  }

  let description;
  if (input.description !== undefined) {
    if (typeof input.description !== 'string') {
      throw inputError('Description must be text');
    }
    description = input.description.trim();
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      throw inputError(`Description cannot exceed ${MAX_DESCRIPTION_LENGTH} characters`);
    }
  }

  let idempotencyKey;
  if (input.idempotencyKey !== undefined) {
    if (typeof input.idempotencyKey !== 'string') {
      throw inputError('Idempotency key must be text');
    }
    idempotencyKey = input.idempotencyKey.trim();
    if (idempotencyKey.length < 8 || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw inputError('Idempotency key must contain between 8 and 128 characters');
    }
  }

  const outcome = input.simulateOutcome === undefined ? 'success' : input.simulateOutcome;
  if (!['success', 'pending', 'failure'].includes(outcome)) {
    throw inputError('Simulated outcome must be success, pending, or failure');
  }

  return {
    phoneNumber: input.phoneNumber.trim(),
    amount: input.amount,
    currency,
    ...(description ? { description } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    outcome
  };
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fingerprint(input) {
  return digest(JSON.stringify([
    input.phoneNumber,
    input.amount,
    input.currency,
    input.description || '',
    input.outcome
  ]));
}

function copyPayment(payment) {
  return {
    ...payment,
    createdAt: new Date(payment.createdAt),
    metadata: { ...payment.metadata },
    ...(payment.error ? { error: { ...payment.error } } : {})
  };
}

function createPaymentReference(idempotencyDigest) {
  return idempotencyDigest
    ? `sim-mm-${idempotencyDigest.slice(0, 32)}`
    : `sim-mm-${crypto.randomUUID()}`;
}

function removeOldestPayment() {
  const oldestReference = payments.keys().next().value;
  if (!oldestReference) return;
  const oldest = payments.get(oldestReference);
  payments.delete(oldestReference);
  if (oldest?.idempotencyDigest) idempotencyKeys.delete(oldest.idempotencyDigest);
}

/** Initiates a payment simulation only; no money is transferred. */
async function initiatePayment(input) {
  const normalized = normalizeInput(input);
  const requestFingerprint = fingerprint(normalized);
  const idempotencyDigest = normalized.idempotencyKey
    ? digest(normalized.idempotencyKey)
    : null;

  if (idempotencyDigest && idempotencyKeys.has(idempotencyDigest)) {
    const prior = idempotencyKeys.get(idempotencyDigest);
    if (prior.fingerprint !== requestFingerprint) {
      const conflict = new Error('Idempotency key was already used for different payment input');
      conflict.name = 'MobileMoneyIdempotencyConflictError';
      conflict.code = 'IDEMPOTENCY_KEY_CONFLICT';
      conflict.status = 409;
      throw conflict;
    }
    return copyPayment(payments.get(prior.paymentReference).result);
  }

  const paymentReference = createPaymentReference(idempotencyDigest);
  const result = {
    simulated: true,
    provider: 'simulated-mobile-money',
    paymentReference,
    status: `simulated_${normalized.outcome}`,
    amount: normalized.amount,
    currency: normalized.currency,
    createdAt: new Date(),
    metadata: { descriptionIncluded: Boolean(normalized.description) },
    ...(normalized.outcome === 'failure'
      ? {
          error: {
            code: 'SIMULATED_PAYMENT_FAILURE',
            message: 'Simulated mobile money provider failure'
          }
        }
      : {})
  };

  if (payments.size >= MAX_STORED_PAYMENTS) removeOldestPayment();
  payments.set(paymentReference, { result, idempotencyDigest });
  if (idempotencyDigest) {
    idempotencyKeys.set(idempotencyDigest, {
      fingerprint: requestFingerprint,
      paymentReference
    });
  }
  return copyPayment(result);
}

/** Returns a known in-memory simulation, or null for an unknown reference. */
async function getPaymentStatus(reference) {
  if (typeof reference !== 'string') return null;
  const payment = payments.get(reference.trim());
  return payment ? copyPayment(payment.result) : null;
}

module.exports = { initiatePayment, getPaymentStatus };
