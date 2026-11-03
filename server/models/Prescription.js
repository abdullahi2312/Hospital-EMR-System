const mongoose = require('mongoose');

const prescriptionSchema = new mongoose.Schema(
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
    drugName: {
      type: String,
      required: [true, 'Drug name is required'],
      trim: true,
      minlength: [1, 'Drug name cannot be empty'],
      maxlength: [200, 'Drug name cannot exceed 200 characters'],
      index: true
    },
    dose: {
      type: String,
      required: [true, 'Dose is required'],
      trim: true,
      minlength: [1, 'Dose cannot be empty'],
      maxlength: [100, 'Dose cannot exceed 100 characters']
    },
    route: {
      type: String,
      required: [true, 'Route is required'],
      enum: {
        values: ['oral', 'injection', 'topical', 'inhalation', 'other'],
        message: 'Route must be oral, injection, topical, inhalation, or other'
      }
    },
    frequency: {
      type: String,
      required: [true, 'Frequency is required'],
      trim: true,
      minlength: [1, 'Frequency cannot be empty'],
      maxlength: [200, 'Frequency cannot exceed 200 characters']
    },
    duration: {
      type: Number,
      required: [true, 'Duration is required'],
      validate: {
        validator: (value) => value > 0,
        message: 'Duration must be a positive number of days'
      }
    },
    quantity: {
      type: Number,
      required: [true, 'Quantity is required'],
      validate: {
        validator: (value) => value > 0,
        message: 'Quantity must be a positive number'
      }
    },
    instructions: {
      type: String,
      trim: true,
      maxlength: [2000, 'Instructions cannot exceed 2000 characters']
    },
    status: {
      type: String,
      enum: {
        values: ['pending', 'partially_dispensed', 'dispensed', 'cancelled'],
        message: 'Status must be pending, partially_dispensed, dispensed, or cancelled'
      },
      default: 'pending',
      index: true
    },
    cancellationReason: {
      type: String,
      trim: true,
      maxlength: [1000, 'Cancellation reason cannot exceed 1000 characters']
    },
    prescribedAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true
  }
);

const Prescription = mongoose.model('Prescription', prescriptionSchema);

module.exports = Prescription;
