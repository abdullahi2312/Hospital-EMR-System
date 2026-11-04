const mongoose = require('mongoose');

const consentSchema = new mongoose.Schema(
  {
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: [true, 'Patient is required'],
      index: true
    },
    doctor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Doctor is required'],
      index: true
    },
    grantedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Granting user is required']
    },
    scope: {
      type: String,
      enum: {
        values: ['clinical_record'],
        message: 'Scope must be clinical_record'
      },
      default: 'clinical_record'
    },
    status: {
      type: String,
      enum: {
        values: ['granted', 'revoked'],
        message: 'Status must be granted or revoked'
      },
      default: 'granted',
      index: true
    },
    grantedAt: {
      type: Date,
      default: Date.now
    },
    revokedAt: {
      type: Date
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [2000, 'Notes cannot exceed 2000 characters']
    }
  },
  {
    timestamps: true
  }
);

consentSchema.pre('save', function syncRevokedAt(next) {
  if (this.isNew || this.isModified('status')) {
    if (this.status === 'revoked') {
      this.revokedAt = this.revokedAt || new Date();
    } else {
      this.revokedAt = undefined;
    }
  }
  next();
});

function syncRevokedAtInUpdate(next) {
  const update = this.getUpdate();

  if (!update || Array.isArray(update)) {
    return next();
  }

  const status = update.$set?.status ?? update.status;

  if (status === 'revoked') {
    update.$set = { ...update.$set, revokedAt: new Date() };
    delete update.revokedAt;
  } else if (status === 'granted') {
    update.$unset = { ...update.$unset, revokedAt: 1 };
    delete update.revokedAt;
    if (update.$set) {
      delete update.$set.revokedAt;
    }
  }

  this.setUpdate(update);
  next();
}

consentSchema.pre('findOneAndUpdate', syncRevokedAtInUpdate);
consentSchema.pre('updateOne', syncRevokedAtInUpdate);

consentSchema.index(
  { patient: 1, doctor: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'granted' },
    name: 'one_active_consent_per_patient_doctor'
  }
);

const Consent = mongoose.model('Consent', consentSchema);

module.exports = Consent;
