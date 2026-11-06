const mongoose = require('mongoose');

const crypto = require('node:crypto');

const IDENTITY_HMAC_MIN_BYTES = 32;

function patientIdentitySecret() {
  const secret = process.env.PATIENT_IDENTITY_HMAC_SECRET;
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < IDENTITY_HMAC_MIN_BYTES) {
    const error = new Error('Patient identity protection is not configured');
    error.name = 'PatientIdentityConfigurationError';
    throw error;
  }
  return secret;
}

function normalizedName(patient) {
  return [patient.firstName, patient.fatherName, patient.grandfatherName]
    .map((part) => String(part || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en'))
    .join(' ');
}

function identityHmac(label, value) {
  return crypto.createHmac('sha256', patientIdentitySecret())
    .update(`patient-identity:${label}:${value}`)
    .digest('hex');
}

function normalizedPhone(phone) {
  return String(phone || '').normalize('NFKC').trim().replace(/\D/g, '').replace(/^00/, '');
}

const patientSchema = new mongoose.Schema(
  {
    mrn: {
      type: String,
      required: [true, 'MRN is required'],
      unique: true,
      trim: true,
      match: [/^MRN-\d{6}$/, 'MRN must use the format MRN-000001']
    },
    identityNameDobKey: {
      type: String,
      select: false,
      match: /^[a-f0-9]{64}$/
    },
    identityNameEstimatedAgeKey: {
      type: String,
      select: false,
      match: /^[a-f0-9]{64}$/
    },
    identityPhoneKey: {
      type: String,
      select: false,
      match: /^[a-f0-9]{64}$/
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

// Supports bounded admin registration analytics filtered by registration time.
patientSchema.index({ createdAt: 1 }, { name: 'patient_registration_analytics_date' });

patientSchema.pre('validate', function setPatientIdentityKeys() {
  const name = normalizedName(this);
  if (name && this.dateOfBirth) {
    const dob = new Date(this.dateOfBirth).toISOString().slice(0, 10);
    this.identityNameDobKey = identityHmac('name-dob', `${name}|${dob}`);
  } else {
    this.identityNameDobKey = undefined;
  }

  if (name && !this.dateOfBirth && this.estimatedAge !== undefined && this.estimatedAge !== null) {
    this.identityNameEstimatedAgeKey = identityHmac(
      'name-estimated-age',
      `${name}|${this.sex}|${String(this.estimatedAge)}`
    );
  } else {
    this.identityNameEstimatedAgeKey = undefined;
  }

  const phoneKey = normalizedPhone(this.phone);
  this.identityPhoneKey = phoneKey ? identityHmac('phone', phoneKey) : undefined;
});

patientSchema.index(
  { identityNameDobKey: 1 },
  {
    unique: true,
    partialFilterExpression: { identityNameDobKey: { $type: 'string' } },
    name: 'unique_patient_normalized_name_dob'
  }
);
patientSchema.index(
  { identityNameEstimatedAgeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { identityNameEstimatedAgeKey: { $type: 'string' } },
    name: 'unique_patient_normalized_name_estimated_age'
  }
);
patientSchema.index(
  { identityPhoneKey: 1 },
  {
    unique: true,
    partialFilterExpression: { identityPhoneKey: { $type: 'string' } },
    name: 'unique_patient_normalized_phone'
  }
);

const Patient = mongoose.model('Patient', patientSchema);
module.exports = Patient;
