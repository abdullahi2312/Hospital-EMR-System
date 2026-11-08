const mongoose = require('mongoose');

const SENSITIVE_DETAIL_KEY = /password|token|secret|clinical.?notes?|emergency.?reason|reason|notes|patient|mrn|phone|address|birth|diagnos|allerg|prescription|medical.?record|name|username|actor|user/i;
const SENSITIVE_DETAIL_VALUE = /patient|mrn-\d+|diagnos|symptom|allerg|prescription|medication|clinical|emergency|treatment|\b(?:ssn|dob)\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i;
const PHONE_LIKE_VALUE = /(?:\+?\d[\d\s().-]{7,}\d)/;

function isSafeDetailValue(value, depth = 0, fieldName) {
  if (depth > 5) {
    return false;
  }

  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return Number.isFinite(value) || typeof value === 'boolean' || value === null;
  }

  if (typeof value === 'string') {
    if (fieldName === 'operationHash' || fieldName === 'operationKey' || fieldName === 'stockAdditionDeduplicationKey') {
      return /^[a-f0-9]{64}$/.test(value);
    }
    return value.length <= 120 &&
      !SENSITIVE_DETAIL_VALUE.test(value) &&
      !PHONE_LIKE_VALUE.test(value) &&
      !/^[a-f\d]{24}$/i.test(value);
  }

  if (Array.isArray(value)) {
    return value.length <= 50 && value.every((item) => isSafeDetailValue(item, depth + 1));
  }

  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }

  const entries = Object.entries(value);
  return entries.length <= 50 && entries.every(([key, nestedValue]) => (
    key.length > 0 &&
    key.length <= 80 &&
    !key.startsWith('$') &&
    !key.includes('.') &&
    !SENSITIVE_DETAIL_KEY.test(key) &&
    isSafeDetailValue(nestedValue, depth + 1, key)
  ));
}

const auditLogSchema = new mongoose.Schema(
  {
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Audit actor is required'],
      immutable: true,
      validate: {
        validator(actorId) {
          return mongoose.isObjectIdOrHexString(actorId);
        },
        message: 'Audit actor must be a valid User ObjectId'
      }
    },
    action: {
      type: String,
      required: [true, 'Audit action is required'],
      trim: true,
      minlength: [1, 'Audit action cannot be empty'],
      maxlength: [120, 'Audit action cannot exceed 120 characters'],
      immutable: true
    },
    entityType: {
      type: String,
      required: [true, 'Audit entity type is required'],
      trim: true,
      minlength: [1, 'Audit entity type cannot be empty'],
      maxlength: [100, 'Audit entity type cannot exceed 100 characters'],
      immutable: true
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      immutable: true
    },
    details: {
      type: mongoose.Schema.Types.Mixed,
      validate: {
        validator(details) {
          return details === undefined || details === null || (
            typeof details === 'object' &&
            !Array.isArray(details) &&
            Object.getPrototypeOf(details) === Object.prototype &&
            isSafeDetailValue(details)
          );
        },
        message: 'Audit details must be a safe metadata object'
      },
      immutable: true
    },
    paymentDeduplicationKey: {
      type: String,
      immutable: true,
      select: false,
      match: [/^[a-f0-9]{64}$/, 'Payment audit deduplication key must be a SHA-256 HMAC']
    },
    patientRegistrationDeduplicationKey: {
      type: String,
      immutable: true,
      select: false,
      match: [/^[a-f0-9]{64}$/, 'Patient registration audit deduplication key must be a SHA-256 HMAC']
    },
    allergyOverride: {
      type: new mongoose.Schema({
        patient: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Patient',
          required: [true, 'Allergy override patient reference is required'],
          immutable: true
        },
        prescription: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Prescription',
          required: [true, 'Allergy override prescription reference is required'],
          immutable: true
        },
        reason: {
          type: String,
          required: [true, 'Allergy override reason is required'],
          trim: true,
          minlength: [20, 'Allergy override reason must contain at least 20 characters'],
          maxlength: [1000, 'Allergy override reason cannot exceed 1000 characters'],
          immutable: true
        }
      }, { _id: false, strict: 'throw' }),
      immutable: true,
      select: false
    },
    ipAddress: {
      type: String,
      trim: true,
      maxlength: [100, 'IP address cannot exceed 100 characters'],
      immutable: true
    },
    userAgent: {
      type: String,
      trim: true,
      maxlength: [1000, 'User agent cannot exceed 1000 characters'],
      immutable: true
    },
    createdAt: {
      type: Date,
      required: [true, 'Audit creation time is required'],
      default: Date.now,
      immutable: true
    }
  },
  {
    timestamps: false,
    strict: 'throw'
  }
);

auditLogSchema.pre('validate', function setServerCreationTime() {
  if (this.isNew) {
    this.createdAt = new Date();
  }
});

function rejectAuditLogMutation(next) {
  next(new Error('AuditLog records are append-only'));
}

auditLogSchema.pre('save', function rejectAuditLogUpdate(next) {
  if (!this.isNew) {
    return rejectAuditLogMutation(next);
  }
  return next();
});

auditLogSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'],
  rejectAuditLogMutation
);

auditLogSchema.pre('deleteOne', { document: true, query: false }, rejectAuditLogMutation);
// bulkWrite bypasses the individual update/delete query middleware above.
// There are no application bulk-write call sites for audit events, so reject
// it outright to preserve the append-only contract.
auditLogSchema.pre('bulkWrite', function rejectAuditLogBulkWrite(next) {
  return rejectAuditLogMutation(next);
});

auditLogSchema.index({ actor: 1 }, { name: 'audit_actor' });
auditLogSchema.index({ action: 1 }, { name: 'audit_action' });
auditLogSchema.index({ entityType: 1, entityId: 1 }, { name: 'audit_entity' });
auditLogSchema.index({ createdAt: -1 }, { name: 'audit_created_at' });
auditLogSchema.index(
  { paymentDeduplicationKey: 1 },
  {
    unique: true,
    partialFilterExpression: { paymentDeduplicationKey: { $type: 'string' } },
    name: 'unique_payment_audit_deduplication_key'
  }
);
auditLogSchema.index(
  { actor: 1, action: 1, 'details.stockAdditionDeduplicationKey': 1 },
  {
    unique: true,
    partialFilterExpression: {
      action: 'inventory_stock_added',
      'details.stockAdditionDeduplicationKey': { $type: 'string' }
    },
    name: 'unique_inventory_stock_addition_audit'
  }
);
auditLogSchema.index(
  { patientRegistrationDeduplicationKey: 1 },
  {
    unique: true,
    partialFilterExpression: { patientRegistrationDeduplicationKey: { $type: 'string' } },
    name: 'unique_patient_registration_audit_deduplication_key'
  }
);
auditLogSchema.index(
  { 'allergyOverride.prescription': 1 },
  {
    unique: true,
    partialFilterExpression: { 'allergyOverride.prescription': { $type: 'objectId' } },
    name: 'unique_prescription_allergy_override_audit'
  }
);
for (const action of ['patient_consent_granted', 'patient_consent_revoked', 'break_glass_activated']) {
  auditLogSchema.index(
    { actor: 1, action: 1, entityType: 1, entityId: 1 },
    {
      unique: true,
      partialFilterExpression: { action, entityId: { $type: 'objectId' } },
      name: `unique_${action}_audit_event`
    }
  );
}

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

module.exports = AuditLog;
