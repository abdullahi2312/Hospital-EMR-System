'use strict';

const crypto = require('node:crypto');

const MAX_MESSAGE_LENGTH = 500;
const MAX_IDEMPOTENCY_ENTRIES = 1000;
const idempotencyCache = new Map();
const ALLOWED_FIELDS = new Set([
  'phoneNumber',
  'message',
  'idempotencyKey',
  'simulateOutcome'
]);

function invalidInput(message) {
  return new TypeError(message);
}

function normalizeInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidInput('SMS input must be an object');
  }
  if (Object.keys(input).some((field) => !ALLOWED_FIELDS.has(field))) {
    throw invalidInput('SMS input contains unsupported fields');
  }

  if (typeof input.phoneNumber !== 'string') {
    throw invalidInput('A valid phone number is required');
  }
  const phoneNumber = input.phoneNumber.trim();
  if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
    throw invalidInput('Phone number must use international E.164 format');
  }

  if (typeof input.message !== 'string') {
    throw invalidInput('A valid SMS message is required');
  }
  const message = input.message.trim();
  if (!message || message.length > MAX_MESSAGE_LENGTH) {
    throw invalidInput(`SMS message must contain between 1 and ${MAX_MESSAGE_LENGTH} characters`);
  }

  let idempotencyKey;
  if (input.idempotencyKey !== undefined) {
    if (typeof input.idempotencyKey !== 'string') {
      throw invalidInput('Idempotency key must be text');
    }
    idempotencyKey = input.idempotencyKey.trim();
    if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw invalidInput('Idempotency key must contain between 8 and 128 characters');
    }
  }

  const outcome = input.simulateOutcome === undefined ? 'success' : input.simulateOutcome;
  if (!['success', 'failure'].includes(outcome)) {
    throw invalidInput('Simulated outcome must be success or failure');
  }

  return { phoneNumber, message, idempotencyKey, outcome };
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function copyResult(result, replayed) {
  return {
    ...result,
    createdAt: new Date(result.createdAt),
    metadata: { ...result.metadata, replayed }
  };
}

function remember(key, fingerprint, result) {
  if (idempotencyCache.size >= MAX_IDEMPOTENCY_ENTRIES) {
    const oldestKey = idempotencyCache.keys().next().value;
    idempotencyCache.delete(oldestKey);
  }
  idempotencyCache.set(key, { fingerprint, result });
}

/**
 * Simulates an SMS attempt. It never contacts a real provider or logs message
 * content or phone numbers. Idempotency is process-local and is not durable.
 */
async function sendSms(input) {
  const normalized = normalizeInput(input);
  const fingerprint = digest(JSON.stringify([
    normalized.phoneNumber,
    normalized.message,
    normalized.outcome
  ]));
  const cacheKey = normalized.idempotencyKey
    ? digest(normalized.idempotencyKey)
    : null;

  if (cacheKey && idempotencyCache.has(cacheKey)) {
    const prior = idempotencyCache.get(cacheKey);
    if (prior.fingerprint !== fingerprint) {
      return {
        simulated: true,
        provider: 'simulated',
        deliveryStatus: 'simulated_failure',
        providerReference: `sim-sms-${cacheKey.slice(0, 24)}`,
        createdAt: new Date(),
        metadata: { messageCharacters: normalized.message.length, replayed: false },
        error: {
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'Idempotency key was already used with different SMS input'
        }
      };
    }
    return copyResult(prior.result, true);
  }

  const providerReference = `sim-sms-${cacheKey
    ? cacheKey.slice(0, 24)
    : crypto.randomUUID()}`;
  const result = {
    simulated: true,
    provider: 'simulated',
    deliveryStatus: normalized.outcome === 'success'
      ? 'simulated_success'
      : 'simulated_failure',
    providerReference,
    createdAt: new Date(),
    metadata: {
      messageCharacters: normalized.message.length,
      replayed: false
    },
    ...(normalized.outcome === 'failure'
      ? {
          error: {
            code: 'SIMULATED_PROVIDER_FAILURE',
            message: 'Simulated SMS provider failure'
          }
        }
      : {})
  };

  if (cacheKey) remember(cacheKey, fingerprint, result);
  return copyResult(result, false);
}

module.exports = { sendSms };
