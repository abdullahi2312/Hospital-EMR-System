const mongoose = require('mongoose');

const accessLogSchema = new mongoose.Schema(
  {
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: [true, 'Patient is required'],
      index: true
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User is required'],
      index: true
    },
    encounter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Encounter',
      index: true
    },
    action: {
      type: String,
      required: [true, 'Access action is required'],
      enum: {
        values: ['view_record', 'view_timeline', 'export_record', 'denied_access', 'break_glass_access'],
        message: 'Action must be a supported access-log action'
      },
      index: true
    },
    accessReason: {
      type: String,
      trim: true,
      maxlength: [1000, 'Access reason cannot exceed 1000 characters']
    },
    accessMethod: {
      type: String,
      required: [true, 'Access method is required'],
      enum: {
        values: ['assigned_visit', 'patient_consent', 'break_glass', 'denied'],
        message: 'Access method must be assigned_visit, patient_consent, break_glass, or denied'
      }
    },
    ipAddress: {
      type: String,
      trim: true,
      maxlength: [100, 'IP address cannot exceed 100 characters']
    },
    userAgent: {
      type: String,
      trim: true,
      maxlength: [1000, 'User agent cannot exceed 1000 characters']
    },
    accessedAt: {
      type: Date,
      default: Date.now,
      index: true
    }
  },
  {
    timestamps: true
  }
);

const AccessLog = mongoose.model('AccessLog', accessLogSchema);

module.exports = AccessLog;
