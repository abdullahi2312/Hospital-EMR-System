'use strict';

const crypto = require('node:crypto');
const mongoose = require('mongoose');

const CURRENCIES = ['USD', 'SOS'];
const STATUSES = ['pending', 'simulated_success', 'simulated_failed'];
const TERMINAL_STATUSES = ['simulated_success', 'simulated_failed'];
const PROVIDER = 'simulated-mobile-money';
const MAX_AMOUNT = 1_000_000;
const FINGERPRINT_SECRET_ENV = 'PAYMENT_FINGERPRINT_SECRET';
const FINGERPRINT_SECRET_MIN_BYTES = 32;
const FINGERPRINT_INPUT_FIELDS = new Set([
  'phoneNumber', 'amount', 'currency', 'description', 'simulateOutcome', 'patientId'
]);

function generatePaymentReference() {
  return `pay-${crypto.randomUUID()}`;
}

function generatedDefault(marker, createValue) {
  return function createServerDefault() {
    const value = createValue();
    this.$locals[marker] = value;
    return value;
  };
}

function normalizeFingerprintInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Payment fingerprint input must be an object');
  }
  if (Object.keys(input).some((field) => !FINGERPRINT_INPUT_FIELDS.has(field))) {
    throw new TypeError('Payment fingerprint input contains unsupported fields');
  }

  if (typeof input.phoneNumber !== 'string' || !/^\+[1-9]\d{7,14}$/.test(input.phoneNumber.trim())) {
    throw new TypeError('Phone number must use international E.164 format');
  }
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount <= 0 || input.amount > MAX_AMOUNT ||
      Math.abs(input.amount * 100 - Math.round(input.amount * 100)) > 1e-7) {
    throw new TypeError('Amount must be positive, finite, supported, and have at most two decimal places');
  }
  if (typeof input.currency !== 'string' || !['USD', 'SOS'].includes(input.currency.trim().toUpperCase())) {
    throw new TypeError('Currency must be USD or SOS');
  }

  let description = '';
  if (input.description !== undefined) {
    if (typeof input.description !== 'string' || input.description.trim().length > 140) {
      throw new TypeError('Description must be text of at most 140 characters');
    }
    description = input.description.trim();
  }

  const outcome = input.simulateOutcome === undefined ? 'success' : input.simulateOutcome;
  if (!['success', 'pending', 'failure'].includes(outcome)) {
    throw new TypeError('Simulated outcome must be success, pending, or failure');
  }

  let patientId = '';
  if (input.patientId !== undefined && input.patientId !== null) {
    if (!mongoose.isObjectIdOrHexString(input.patientId)) {
      throw new TypeError('Patient ID must be a valid ObjectId');
    }
    patientId = String(input.patientId).toLowerCase();
  }

  return JSON.stringify({
    phoneNumber: input.phoneNumber.trim(),
    amount: input.amount,
    currency: input.currency.trim().toUpperCase(),
    description,
    simulateOutcome: outcome,
    patientId
  });
}

function getPaymentFingerprintSecret() {
  const secret = process.env[FINGERPRINT_SECRET_ENV];
  if (typeof secret !== 'string') {
    const error = new Error('Payment fingerprint configuration is unavailable');
    error.name = 'PaymentFingerprintConfigurationError';
    error.status = 503;
    throw error;
  }

  const normalized = secret.trim();
  if (Buffer.byteLength(normalized, 'utf8') < FINGERPRINT_SECRET_MIN_BYTES ||
      /placeholder|replace[_ -]?with|change[_ -]?me|your[_ -]?secret|example/i.test(normalized)) {
    const error = new Error('Payment fingerprint configuration is invalid');
    error.name = 'PaymentFingerprintConfigurationError';
    error.status = 503;
    throw error;
  }
  return normalized;
}

function safePaymentSerialization(_document, result) {
  delete result.inputFingerprint;
  delete result.idempotencyKey;
  return result;
}

function hasStatusUpdate(update) {
  return Boolean(
    Object.prototype.hasOwnProperty.call(update || {}, 'status') ||
    Object.prototype.hasOwnProperty.call(update?.$set || {}, 'status') ||
    Object.prototype.hasOwnProperty.call(update?.$unset || {}, 'status') ||
    Object.prototype.hasOwnProperty.call(update?.$setOnInsert || {}, 'status')
  );
}

function guardAtomicStatusUpdate(next) {
  const update = this.getUpdate() || {};
  if (!hasStatusUpdate(update)) return next();

  const nextStatus = update.$set?.status ?? update.status;
  if (
    this.getFilter()?.status !== 'pending' ||
    !TERMINAL_STATUSES.includes(nextStatus) ||
    update.$unset?.status !== undefined ||
    this.getOptions()?.upsert === true
  ) {
    return next(new Error('Payment status can only transition atomically from pending to a terminal simulated status'));
  }
  return next();
}

const paymentSchema = new mongoose.Schema(
  {
    paymentReference: {
      type: String,
      required: [true, 'Payment reference is required'],
      default: generatedDefault('serverPaymentReference', generatePaymentReference),
      immutable: true,
      trim: true,
      match: [/^pay-[0-9a-f-]{36}$/, 'Payment reference must be server-generated']
    },
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      immutable: true
    },
    initiatingUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Initiating user is required'],
      immutable: true
    },
    amount: {
      type: Number,
      required: [true, 'Payment amount is required'],
      immutable: true,
      min: [Number.EPSILON, 'Payment amount must be greater than zero'],
      max: [MAX_AMOUNT, `Payment amount cannot exceed ${MAX_AMOUNT}`],
      validate: {
        validator(value) {
          return Number.isFinite(value) && Math.abs(value * 100 - Math.round(value * 100)) <= 1e-7;
        },
        message: 'Payment amount must be finite and have at most two decimal places'
      }
    },
    currency: {
      type: String,
      required: [true, 'Payment currency is required'],
      immutable: true,
      uppercase: true,
      trim: true,
      enum: { values: CURRENCIES, message: 'Currency must be USD or SOS' }
    },
    status: {
      type: String,
      required: true,
      enum: { values: STATUSES, message: 'Payment status is invalid' },
      default: 'pending'
    },
    provider: {
      type: String,
      required: true,
      default: PROVIDER,
      immutable: true,
      enum: { values: [PROVIDER], message: 'Only simulated mobile money payments are supported' }
    },
    idempotencyKey: {
      type: String,
      required: [true, 'Idempotency key is required'],
      immutable: true,
      select: false,
      trim: true,
      minlength: [8, 'Idempotency key must contain at least 8 characters'],
      maxlength: [128, 'Idempotency key cannot exceed 128 characters']
    },
    inputFingerprint: {
      type: String,
      required: [true, 'Payment input fingerprint is required'],
      immutable: true,
      select: false,
      match: [/^[a-f0-9]{64}$/, 'Payment input fingerprint is invalid']
    },
    description: {
      type: String,
      immutable: true,
      trim: true,
      maxlength: [140, 'Payment description cannot exceed 140 characters']
    },
    createdAt: {
      type: Date,
      default: generatedDefault('serverCreatedAt', () => new Date()),
      immutable: true
    },
    updatedAt: {
      type: Date,
      default: generatedDefault('serverUpdatedAt', () => new Date())
    }
  },
  {
    timestamps: true,
    strict: 'throw',
    toJSON: { transform: safePaymentSerialization },
    toObject: { transform: safePaymentSerialization }
  }
);

paymentSchema.index(
  { paymentReference: 1 },
  { unique: true, name: 'unique_payment_reference' }
);
paymentSchema.index(
  { initiatingUser: 1, idempotencyKey: 1 },
  { unique: true, name: 'unique_payment_idempotency_per_user' }
);
// Supports bounded admin payment analytics filtered by payment creation date.
paymentSchema.index({ createdAt: 1 }, { name: 'payment_analytics_date' });

paymentSchema.pre('validate', function requirePendingInitialState(next) {
  if (this.isNew && this.paymentReference !== this.$locals.serverPaymentReference) {
    this.invalidate('paymentReference', 'Payment reference must be generated by the server');
  }
  if (
    this.isNew &&
    (!(this.createdAt instanceof Date) ||
      this.createdAt.getTime() !== this.$locals.serverCreatedAt?.getTime())
  ) {
    this.invalidate('createdAt', 'Creation timestamp must be generated by the server');
  }
  if (
    this.isNew &&
    (!(this.updatedAt instanceof Date) ||
      this.updatedAt.getTime() !== this.$locals.serverUpdatedAt?.getTime())
  ) {
    this.invalidate('updatedAt', 'Update timestamp must be generated by the server');
  }
  if (this.isNew && this.status !== 'pending') {
    this.invalidate('status', 'New payments must begin in pending status');
  }
  next();
});

paymentSchema.pre('save', function requireConditionalStatusUpdate(next) {
  if (!this.isNew && this.isModified('status')) {
    return next(new Error('Payment status changes must use an atomic conditional update'));
  }
  return next();
});

paymentSchema.pre('findOneAndUpdate', guardAtomicStatusUpdate);
paymentSchema.pre('updateOne', guardAtomicStatusUpdate);
paymentSchema.pre('updateMany', function rejectBulkStatusUpdate(next) {
  if (hasStatusUpdate(this.getUpdate() || {})) {
    return next(new Error('Bulk payment status updates are not allowed'));
  }
  return next();
});

paymentSchema.statics.transitionStatus = function transitionStatus(paymentReference, nextStatus) {
  if (!TERMINAL_STATUSES.includes(nextStatus)) {
    throw new TypeError('Payment status must transition to simulated_success or simulated_failed');
  }
  return this.findOneAndUpdate(
    { paymentReference, status: 'pending' },
    { $set: { status: nextStatus } },
    { new: true, runValidators: true }
  );
};

paymentSchema.statics.createInputFingerprint = function createInputFingerprint(input) {
  const normalizedInput = normalizeFingerprintInput(input);
  const secret = getPaymentFingerprintSecret();
  return crypto.createHmac('sha256', secret).update(normalizedInput, 'utf8').digest('hex');
};

const Payment = mongoose.model('Payment', paymentSchema);

module.exports = Payment;
