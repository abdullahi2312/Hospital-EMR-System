const mongoose = require('mongoose');

const labOrderComponentSchema = new mongoose.Schema(
  {
    componentId: { type: String, required: true, trim: true, lowercase: true, minlength: 1, maxlength: 80, match: /^[a-z0-9][a-z0-9._-]*$/ },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 200 }
  },
  { _id: false }
);

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
    // Missing components represent legacy single-test orders.
    components: {
      type: [labOrderComponentSchema],
      default: undefined,
      validate: {
        validator(components) {
          if (components === undefined) return true;
          if (!Array.isArray(components) || components.length === 0) return false;
          const ids = components.map((component) => component.componentId?.toLowerCase());
          return ids.every(Boolean) && new Set(ids).size === ids.length;
        },
        message: 'Lab order components must be non-empty and have unique component IDs'
      }
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
        values: ['pending', 'sample_collected', 'processing', 'completed', 'sample_rejected', 'cancelled'],
        message: 'Status must be pending, sample_collected, processing, completed, sample_rejected, or cancelled'
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
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true
    },
    cancelledAt: {
      type: Date
    },
    cancellationRequestHash: {
      type: String,
      select: false
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
