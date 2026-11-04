const mongoose = require('mongoose');

const encounterSchema = new mongoose.Schema(
  {
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: [true, 'Patient is required'],
      index: true
    },
    visitNumber: {
      type: String,
      required: [true, 'Visit number is required'],
      unique: true,
      trim: true
    },
    department: {
      type: String,
      required: [true, 'Department is required'],
      trim: true
    },
    assignedDoctor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true
    },
    status: {
      type: String,
      enum: {
        values: ['open', 'in_progress', 'closed'],
        message: 'Status must be open, in_progress, or closed'
      },
      default: 'open',
      index: true
    },
    visitType: {
      type: String,
      required: [true, 'Visit type is required'],
      enum: {
        values: ['outpatient', 'inpatient', 'emergency'],
        message: 'Visit type must be outpatient, inpatient, or emergency'
      }
    },
    chiefComplaint: {
      type: String,
      trim: true
    },
    clinicalNotes: {
      type: String,
      trim: true,
      maxlength: [10000, 'Clinical notes cannot exceed 10000 characters']
    },
    examinationFindings: {
      type: String,
      trim: true,
      maxlength: [10000, 'Examination findings cannot exceed 10000 characters']
    },
    assessment: {
      type: String,
      trim: true,
      maxlength: [5000, 'Assessment cannot exceed 5000 characters']
    },
    treatmentPlan: {
      type: String,
      trim: true,
      maxlength: [10000, 'Treatment plan cannot exceed 10000 characters']
    },
    followUpInstructions: {
      type: String,
      trim: true,
      maxlength: [5000, 'Follow-up instructions cannot exceed 5000 characters']
    },
    openedAt: {
      type: Date,
      default: Date.now
    },
    closedAt: {
      type: Date
    }
  },
  {
    timestamps: true
  }
);

const Encounter = mongoose.model('Encounter', encounterSchema);

module.exports = Encounter;
