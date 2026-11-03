const mongoose = require('mongoose');

const labOrderSchema = new mongoose.Schema(
  {
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: [true, 'Patient is required'],
      index: true
    },
    encounter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Encounter',
      required: [true, 'Encounter is required'],
      index: true
    },
    doctor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Doctor is required'],
      index: true
    },
    testName: {
      type: String,
      required: [true, 'Test name is required'],
      trim: true,
      minlength: [1, 'Test name cannot be empty'],
      maxlength: [200, 'Test name cannot exceed 200 characters']
    },
    instructions: {
      type: String,
      trim: true,
      maxlength: [2000, 'Instructions cannot exceed 2000 characters']
    },
    priority: {
      type: String,
      enum: {
        values: ['routine', 'urgent', 'emergency'],
        message: 'Priority must be routine, urgent, or emergency'
      },
      default: 'routine'
    },
    status: {
      type: String,
      enum: {
        values: ['pending', 'sample_collected', 'processing', 'completed', 'sample_rejected'],
        message: 'Status must be pending, sample_collected, processing, completed, or sample_rejected'
      },
      default: 'pending',
      index: true
    },
    technician: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true
    },
    rejectionReason: {
      type: String,
      trim: true,
      maxlength: [1000, 'Rejection reason cannot exceed 1000 characters']
    },
    orderedAt: {
      type: Date,
      default: Date.now
    },
    completedAt: {
      type: Date
    }
  },
  {
    timestamps: true
  }
);

const LabOrder = mongoose.model('LabOrder', labOrderSchema);

module.exports = LabOrder;
