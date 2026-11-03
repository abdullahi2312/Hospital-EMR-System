const mongoose = require('mongoose');

const HOURS_24_IN_MS = 24 * 60 * 60 * 1000;

const breakGlassSchema = new mongoose.Schema(
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
    reason: {
      type: String,
      required: [true, 'Break-glass reason is required'],
      trim: true,
      minlength: [20, 'Reason must be at least 20 characters long'],
      maxlength: [2000, 'Reason cannot exceed 2000 characters']
    },
    status: {
      type: String,
      enum: {
        values: ['active', 'expired', 'justified', 'not_justified'],
        message: 'Status must be active, expired, justified, or not_justified'
      },
      default: 'active',
      index: true
    },
    activatedAt: {
      type: Date,
      default: Date.now
    },
    expiresAt: {
      type: Date,
      required: [true, 'Expiration time is required'],
      index: true,
      validate: [
        {
          validator(value) {
            return value > this.activatedAt;
          },
          message: 'Expiration time must be later than activation time'
        },
        {
          validator(value) {
            if (!this.isNew) {
              return true;
            }
            return value.getTime() - this.activatedAt.getTime() === HOURS_24_IN_MS;
          },
          message: 'Expiration time must be exactly 24 hours after activation when created'
        }
      ]
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    reviewedAt: {
      type: Date
    },
    reviewNotes: {
      type: String,
      trim: true,
      maxlength: [2000, 'Review notes cannot exceed 2000 characters']
    }
  },
  {
    timestamps: true
  }
);

const BreakGlass = mongoose.model('BreakGlass', breakGlassSchema);

module.exports = BreakGlass;
