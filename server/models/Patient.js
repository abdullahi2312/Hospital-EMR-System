const mongoose = require('mongoose');

const patientSchema = new mongoose.Schema(
  {
    mrn: {
      type: String,
      required: [true, 'MRN is required'],
      unique: true,
      trim: true,
      match: [/^MRN-\d{6}$/, 'MRN must use the format MRN-000001']
    },
    firstName: {
      type: String,
      required: [true, 'First name is required'],
      trim: true,
      minlength: [1, 'First name cannot be empty'],
      maxlength: [100, 'First name cannot exceed 100 characters']
    },
    fatherName: {
      type: String,
      required: [true, 'Father name is required'],
      trim: true,
      minlength: [1, 'Father name cannot be empty'],
      maxlength: [100, 'Father name cannot exceed 100 characters']
    },
    grandfatherName: {
      type: String,
      required: [true, 'Grandfather name is required'],
      trim: true,
      minlength: [1, 'Grandfather name cannot be empty'],
      maxlength: [100, 'Grandfather name cannot exceed 100 characters']
    },
    sex: {
      type: String,
      required: [true, 'Sex is required'],
      enum: { values: ['male', 'female'], message: 'Sex must be male or female' }
    },
    dateOfBirth: {
      type: Date,
      required: [function requireDateOfBirth() { return this.estimatedAge == null; }, 'Provide a date of birth or estimated age']
    },
    estimatedAge: {
      type: Number,
      required: [function requireEstimatedAge() { return this.dateOfBirth == null; }, 'Provide an estimated age or date of birth'],
      min: [0, 'Estimated age cannot be negative'],
      max: [150, 'Estimated age cannot exceed 150']
    },
    phone: { type: String, trim: true, maxlength: [30, 'Phone number cannot exceed 30 characters'] },
    district: { type: String, trim: true, maxlength: [100, 'District cannot exceed 100 characters'] },
    emergencyContact: { type: String, trim: true, maxlength: [100, 'Emergency contact cannot exceed 100 characters'] },
    allergies: {
      type: [{ type: String, trim: true, maxlength: [100, 'Allergy entry cannot exceed 100 characters'] }],
      default: []
    },
    allergyStatus: {
      type: String,
      enum: { values: ['recorded', 'none_known', 'not_recorded'], message: 'Allergy status must be recorded, none_known, or not_recorded' },
      default: 'not_recorded'
    },
    registeredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Registering user is required'],
      index: true
    }
  },
  { timestamps: true }
);

const Patient = mongoose.model('Patient', patientSchema);
module.exports = Patient;
