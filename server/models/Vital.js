const mongoose = require('mongoose');

const bloodPressureSchema = new mongoose.Schema(
  {
    systolic: {
      type: Number,
      required: [true, 'Systolic blood pressure is required'],
      min: [0, 'Systolic blood pressure cannot be negative']
    },
    diastolic: {
      type: Number,
      required: [true, 'Diastolic blood pressure is required'],
      min: [0, 'Diastolic blood pressure cannot be negative']
    }
  },
  { _id: false }
);

const vitalSchema = new mongoose.Schema(
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
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Recording user is required']
    },
    bloodPressure: {
      type: bloodPressureSchema,
      required: [true, 'Blood pressure is required']
    },
    temperature: {
      type: Number,
      required: [true, 'Temperature is required'],
      min: [0, 'Temperature cannot be below 0°C'],
      max: [45, 'Temperature cannot exceed 45°C']
    },
    pulse: {
      type: Number,
      required: [true, 'Pulse is required'],
      min: [0, 'Pulse cannot be negative']
    },
    weight: {
      type: Number,
      required: [true, 'Weight is required'],
      min: [0, 'Weight cannot be negative']
    },
    height: {
      type: Number,
      min: [0, 'Height cannot be negative']
    },
    oxygenSaturation: {
      type: Number,
      min: [0, 'Oxygen saturation cannot be below 0%'],
      max: [100, 'Oxygen saturation cannot exceed 100%']
    },
    recordedAt: {
      type: Date,
      default: Date.now,
      index: true
    }
  },
  {
    timestamps: true
  }
);

const Vital = mongoose.model('Vital', vitalSchema);

module.exports = Vital;
