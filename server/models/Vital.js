const mongoose = require('mongoose');

const bloodPressureSchema = new mongoose.Schema(
  {
    systolic: {
      type: Number,
      required: [true, 'Systolic blood pressure is required'],
      min: [10, 'Systolic blood pressure is below the accepted limit'],
      max: [350, 'Systolic blood pressure exceeds the accepted limit']
    },
    diastolic: {
      type: Number,
      required: [true, 'Diastolic blood pressure is required'],
      min: [5, 'Diastolic blood pressure is below the accepted limit'],
      max: [250, 'Diastolic blood pressure exceeds the accepted limit']
    }
  },
  { _id: false, strict: 'throw' }
);

bloodPressureSchema.pre('validate', function validatePressureRelationship() {
  if (Number.isFinite(this.systolic) && Number.isFinite(this.diastolic) && this.systolic <= this.diastolic) {
    this.invalidate('systolic', 'Systolic blood pressure must be greater than diastolic blood pressure');
  }
});

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
      min: [10, 'Temperature is below the accepted limit in °C'],
      max: [45, 'Temperature cannot exceed 45°C']
    },
    respiratoryRate: {
      type: Number,
      min: [1, 'Respiratory rate must be at least 1 breath per minute'],
      max: [150, 'Respiratory rate cannot exceed 150 breaths per minute']
    },
    pulse: {
      type: Number,
      required: [true, 'Pulse is required'],
      min: [1, 'Heart rate must be at least 1 beat per minute'],
      max: [400, 'Heart rate cannot exceed 400 beats per minute']
    },
    weight: {
      type: Number,
      required: [true, 'Weight is required'],
      min: [0.01, 'Weight must be greater than 0 kg'],
      max: [1000, 'Weight cannot exceed 1000 kg']
    },
    height: {
      type: Number,
      min: [5, 'Height must be at least 5 cm'],
      max: [350, 'Height cannot exceed 350 cm']
    },
    oxygenSaturation: {
      type: Number,
      min: [1, 'Oxygen saturation must be greater than 0%'],
      max: [100, 'Oxygen saturation cannot exceed 100%']
    },
    recordedAt: {
      type: Date,
      default: Date.now,
      index: true
    }
  },
  {
    timestamps: true,
    strict: 'throw'
  }
);

const Vital = mongoose.model('Vital', vitalSchema);

module.exports = Vital;
