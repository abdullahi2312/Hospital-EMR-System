const mongoose = require('mongoose');

const USER_ROLES = [
  'receptionist',
  'doctor',
  'lab_technician',
  'pharmacist',
  'patient',
  'admin'
];

const userSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: [true, 'Full name is required'],
      trim: true,
      minlength: [2, 'Full name must be at least 2 characters long'],
      maxlength: [100, 'Full name cannot exceed 100 characters']
    },
    username: {
      type: String,
      required: [true, 'Username is required'],
      unique: true,
      lowercase: true,
      trim: true,
      minlength: [3, 'Username must be at least 3 characters long'],
      maxlength: [30, 'Username cannot exceed 30 characters']
    },
    // Authentication code must hash the value before saving a user.
    password: {
      type: String,
      required: [true, 'Password is required'],
      select: false
    },
    role: {
      type: String,
      required: [true, 'Role is required'],
      enum: {
        values: USER_ROLES,
        message: 'Role must be one of the supported user roles'
      },
      validate: {
        validator(role) {
          return role === 'patient' ? this.patient != null : this.patient == null;
        },
        message: 'Patient users must have a patient link; other roles must not have one'
      }
    },
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: [
        function requirePatientLink() {
          return this.role === 'patient';
        },
        'Patient reference is required for users with the patient role'
      ],
      validate: {
        validator(patientId) {
          return this.role === 'patient' ? patientId != null : patientId == null;
        },
        message: 'Only users with the patient role may have a Patient reference'
      }
    },
    phone: {
      type: String,
      trim: true,
      maxlength: [30, 'Phone number cannot exceed 30 characters']
    },
    isActive: {
      type: Boolean,
      default: true
    }
  },
  {
    timestamps: true
  }
);

userSchema.index(
  { patient: 1 },
  {
    unique: true,
    partialFilterExpression: { patient: { $type: 'objectId' } },
    name: 'unique_patient_portal_account'
  }
);

const User = mongoose.model('User', userSchema);

module.exports = User;
