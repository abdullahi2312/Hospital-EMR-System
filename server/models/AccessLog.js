const mongoose = require('mongoose');

function rejectAccessLogMutation(next) {
  next(new Error('AccessLog records are append-only'));
}

const ALLOWED_ACCESS_PURPOSES = new Set([
  'View encounter summary',
  'Add encounter diagnosis',
  'Retrieve encounter diagnoses',
  'Update encounter notes',
  'Create laboratory order',
  'Create medication prescription',
  'Record vital signs',
  'Retrieve encounter vital signs',
  'FHIR read-only resource access'
]);

function validateAccessPurpose(value) {
  if (value === undefined || value === null || value === '') return true;
  // A purpose is selected from server-defined phrases so arbitrary clinical or
  // identifying text cannot be persisted as an access reason.
  return typeof value === 'string' && value.length <= 100 && ALLOWED_ACCESS_PURPOSES.has(value);
}

function objectIdValidator(value) {
  return value == null || mongoose.isObjectIdOrHexString(value);
}

const accessLogSchema = new mongoose.Schema(
  {
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: [true, 'Patient is required'],
      index: true,
      immutable: true,
      validate: { validator: mongoose.isObjectIdOrHexString, message: 'Patient must be a valid ObjectId' }
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User is required'],
      index: true,
      immutable: true,
      validate: { validator: mongoose.isObjectIdOrHexString, message: 'User must be a valid ObjectId' }
    },
    encounter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Encounter',
      index: true,
      immutable: true,
      validate: { validator: objectIdValidator, message: 'Encounter must be a valid ObjectId' }
    },
    consent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Consent',
      immutable: true,
      validate: { validator: objectIdValidator, message: 'Consent must be a valid ObjectId' }
    },
    breakGlass: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BreakGlass',
      immutable: true,
      validate: { validator: objectIdValidator, message: 'BreakGlass must be a valid ObjectId' }
    },
    action: {
      type: String,
      required: [true, 'Access action is required'],
      enum: {
        values: ['view_record', 'view_timeline', 'export_record', 'denied_access', 'break_glass_access'],
        message: 'Action must be a supported access-log action'
      },
      index: true,
      immutable: true
    },
    accessReason: {
      type: String,
      trim: true,
      maxlength: [500, 'Access reason cannot exceed 500 characters'],
      immutable: true,
      validate: {
        validator: validateAccessPurpose,
        message: 'Access reason must be a short purpose without sensitive or identifying details'
      }
    },
    accessMethod: {
      type: String,
      required: [true, 'Access method is required'],
      enum: {
        values: ['assigned_visit', 'patient_consent', 'patient_portal', 'break_glass', 'denied'],
        message: 'Access method must be assigned_visit, patient_consent, patient_portal, break_glass, or denied'
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
    accessedAt: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
      immutable: true
    },
    createdAt: {
      type: Date,
      required: true,
      default: Date.now,
      immutable: true
    },
    updatedAt: {
      type: Date,
      required: true,
      default: Date.now,
      immutable: true
    }
  },
  {
    timestamps: false,
    strict: 'throw'
  }
);

accessLogSchema.pre('validate', function setServerTimestamps() {
  if (this.isNew) {
    const now = new Date();
    this.accessedAt = now;
    this.createdAt = now;
    this.updatedAt = now;
  }
});

accessLogSchema.pre('save', function rejectAccessLogSaveUpdate(next) {
  if (!this.isNew) return rejectAccessLogMutation(next);
  return next();
});

accessLogSchema.pre('insertMany', function setInsertManyServerTimestamps(next, documents) {
  const now = new Date();
  for (const document of documents || []) {
    document.accessedAt = now;
    document.createdAt = now;
    document.updatedAt = now;
  }
  next();
});

accessLogSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'findByIdAndDelete', 'remove'],
  rejectAccessLogMutation
);

accessLogSchema.pre('deleteOne', { document: true, query: false }, rejectAccessLogMutation);
accessLogSchema.pre('deleteMany', { document: true, query: false }, rejectAccessLogMutation);
accessLogSchema.pre('bulkWrite', function rejectAccessLogBulkWrite(next, operations) {
  const now = new Date();
  for (const operation of operations || []) {
    if (operation.updateOne || operation.updateMany || operation.replaceOne || operation.deleteOne || operation.deleteMany) {
      return rejectAccessLogMutation(next);
    }
    if (operation.insertOne?.document) {
      operation.insertOne.document.accessedAt = now;
      operation.insertOne.document.createdAt = now;
      operation.insertOne.document.updatedAt = now;
    } else {
      return rejectAccessLogMutation(next);
    }
  }
  return next();
});

accessLogSchema.pre('validate', function preventConflictingAuthorizationRecords() {
  if (this.consent && this.breakGlass) {
    this.invalidate(
      'breakGlass',
      'An access event cannot be justified by both consent and break-glass records'
    );
  }
});

const AccessLog = mongoose.model('AccessLog', accessLogSchema);

module.exports = AccessLog;
