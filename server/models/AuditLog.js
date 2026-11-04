const mongoose = require('mongoose');

const SENSITIVE_DETAIL_KEY = /password|token|secret|clinical.?notes?|emergency.?reason|reason|notes|patient|mrn|phone|address|birth|diagnos|allerg|prescription|medical.?record|name|username|actor|user/i;
const SENSITIVE_DETAIL_VALUE = /patient|mrn-\d+|diagnos|symptom|allerg|prescription|medication|clinical|emergency|treatment|\b(?:ssn|dob)\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i;
const PHONE_LIKE_VALUE = /(?:\+?\d[\d\s().-]{7,}\d)/;

function isSafeDetailValue(value, depth = 0) {
  if (depth > 5) {
    return false;
  }

  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return Number.isFinite(value) || typeof value === 'boolean' || value === null;
  }

  if (typeof value === 'string') {
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
    isSafeDetailValue(nestedValue, depth + 1)
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

auditLogSchema.index({ actor: 1 }, { name: 'audit_actor' });
auditLogSchema.index({ action: 1 }, { name: 'audit_action' });
auditLogSchema.index({ entityType: 1, entityId: 1 }, { name: 'audit_entity' });
auditLogSchema.index({ createdAt: -1 }, { name: 'audit_created_at' });

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

module.exports = AuditLog;
