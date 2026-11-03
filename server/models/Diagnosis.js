const mongoose = require('mongoose');

const diagnosisSchema = new mongoose.Schema(
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
    code: {
      type: String,
      trim: true,
      index: true
    },
    description: {
      type: String,
      required: [true, 'Diagnosis description is required'],
      trim: true,
      minlength: [1, 'Diagnosis description cannot be empty'],
      maxlength: [1000, 'Diagnosis description cannot exceed 1000 characters']
    },
    isPrimary: {
      type: Boolean,
      default: false
    },
    diagnosedAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true
  }
);

diagnosisSchema.index(
  { encounter: 1 },
  {
    unique: true,
    partialFilterExpression: { isPrimary: true },
    name: 'unique_primary_diagnosis_per_encounter'
  }
);

const Diagnosis = mongoose.model('Diagnosis', diagnosisSchema);

module.exports = Diagnosis;
