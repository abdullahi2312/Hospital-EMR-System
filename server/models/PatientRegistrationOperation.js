const mongoose = require('mongoose');

const patientRegistrationOperationSchema = new mongoose.Schema(
  {
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true
    },
    idempotencyKeyHash: {
      type: String,
      required: true,
      immutable: true,
      select: false,
      match: /^[a-f0-9]{64}$/
    },
    inputFingerprint: {
      type: String,
      required: true,
      immutable: true,
      select: false,
      match: /^[a-f0-9]{64}$/
    },
    auditDeduplicationKey: {
      type: String,
      required: true,
      immutable: true,
      select: false,
      match: /^[a-f0-9]{64}$/
    },
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: true,
      immutable: true,
      unique: true
    },
    status: {
      type: String,
      enum: ['pending', 'creating', 'created', 'duplicate_rejected'],
      default: 'pending'
    },
    leaseToken: {
      type: String,
      select: false
    },
    leaseUntil: Date,
    auditCompleted: {
      type: Boolean,
      default: false
    }
  },
  { timestamps: true, strict: 'throw' }
);

patientRegistrationOperationSchema.index(
  { actor: 1, idempotencyKeyHash: 1 },
  { unique: true, name: 'unique_patient_registration_per_actor_key' }
);

function rejectOperationDeletion(next) {
  next(new Error('Patient registration operation records cannot be deleted'));
}

patientRegistrationOperationSchema.pre(
  ['deleteOne', 'deleteMany', 'findOneAndDelete', 'replaceOne', 'findOneAndReplace'],
  rejectOperationDeletion
);

const PatientRegistrationOperation = mongoose.model(
  'PatientRegistrationOperation',
  patientRegistrationOperationSchema
);

module.exports = PatientRegistrationOperation;
